import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

import { CONFIG } from "./fixtures";
import { homeHandlers, homeSnapshot } from "./home-api";
import { installRoutesApi } from "./routes-api";

// S1 (`experiments/remix-v3/ACTION-PLAN.md` B): the bridge renders `/` and `/pane/:paneId`, and the
// browser adopts that document in place. `e2e/serve.ts` renders exactly as the bridge does when the
// request carries `e2e-ssr=1`, from the snapshot this spec posts to `/__ssr`; `/api/*` is stubbed
// (page.route) with the SAME snapshot, so a poll after hydration changes no structure.
//
//   (a) the rows are in the document with JavaScript off
//   (b) from document start to hydrated, no element node is removed and no splash is ever drawn
//       (the one exception is the runtime's own `rmx-data` script, dropped once read; it paints nothing)
//   (c) the first tap to a pane: mutation count and time (the body is replaced once, by design)
//   (d) back returns to the dashboard
//   (e) the static shell still boots when the document route answers 403, and offline (service worker)
//   (f) a tall dashboard keeps its scroll position across hydration

const NOW = 1_790_000_000_000;
const SNAP = homeSnapshot(NOW, false);

/** A dashboard taller than the phone: 24 spaces of two panes each. */
function tallSnapshot(): SnapshotResponse {
  const base = homeSnapshot(NOW, false);
  const agents = [];
  const workspaces = [];
  const tabs = [];
  for (let w = 1; w <= 24; w++) {
    const workspaceId = `w${String(w)}`;
    const tabId = `${workspaceId}:t1`;
    workspaces.push({ workspaceId, number: w, label: `space-${String(w)}`, focused: w === 1, activeTabId: tabId, tabCount: 1, paneCount: 2 });
    tabs.push({ tabId, workspaceId, number: 1, label: "main", focused: true, paneCount: 2 });
    for (let p = 1; p <= 2; p++) {
      agents.push({
        ...base.agents[0]!,
        paneId: `${workspaceId}:p${String(p)}`,
        workspaceId,
        workspaceLabel: `space-${String(w)}`,
        workspaceNumber: w,
        tabId,
        tabLabel: "main",
        status: "idle" as const,
        host: undefined,
        cache: undefined,
      });
    }
  }
  return { bridge: "connected", ts: NOW, agents, shellPanes: [], workspaces, tabs };
}

async function useServerDocuments(context: BrowserContext, baseURL: string, snapshot: SnapshotResponse, config: BridgeConfig = CONFIG): Promise<void> {
  const res = await context.request.post(`${baseURL}/__ssr`, { data: { snapshot, config } });
  expect(res.status()).toBe(204);
  await context.addCookies([{ name: "e2e-ssr", value: "1", url: baseURL }]);
}

interface Watch {
  removed: number;
  /** The first few removed elements, as `tag[data-slot|data-testid|class]`, for a failure message. */
  removedWhat: string[];
  added: number;
  textChanges: number;
  splash: boolean;
  clickAt: number;
  paneAt: number;
  armed: boolean;
}

declare global {
  interface Window {
    __ssrWatch: Watch;
  }
}

/** A MutationObserver on the document from its very first node. */
async function watchMutations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const watch: Watch = { removed: 0, removedWhat: [], added: 0, textChanges: 0, splash: false, clickAt: 0, paneAt: 0, armed: false };
    window.__ssrWatch = watch;
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "characterData") watch.textChanges++;
        for (const node of record.removedNodes) {
          // The runtime takes its own `rmx-data` script out once it has read the props; it paints nothing.
          if (!(node instanceof Element) || node.tagName === "SCRIPT") continue;
          watch.removed++;
          if (watch.removedWhat.length < 5) {
            const tag = node.getAttribute("data-slot") ?? node.getAttribute("data-testid") ?? node.getAttribute("class")?.slice(0, 40) ?? "";
            const parent = record.target instanceof Element ? record.target.tagName.toLowerCase() : "?";
            watch.removedWhat.push(`${node.tagName.toLowerCase()}[${tag}] in ${parent}`);
          }
        }
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) watch.added++;
      }
      if (document.querySelector(".boot-splash") !== null) watch.splash = true;
      if (watch.armed && watch.paneAt === 0 && document.querySelector('[data-testid="pane-view"]') !== null) watch.paneAt = performance.now();
    }).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener(
      "click",
      () => {
        if (watch.armed && watch.clickAt === 0) watch.clickAt = performance.now();
      },
      true,
    );
  });
}

/** Resolves once the hydrated app has polled: the runtime is up and the Shell's setup ran. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForRequest((req) => new URL(req.url()).pathname === "/api/snapshot");
  // One frame for the poll's answer to land; the same snapshot, so nothing structural should move.
  await page.waitForTimeout(300);
}

test.describe("server document boot", () => {
  test.use({ serviceWorkers: "block" });

  test("(a) rows are in the document with JavaScript blocked", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await useServerDocuments(context, baseURL!, SNAP);
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("pane-row").first()).toBeVisible();
    expect(await page.getByTestId("pane-row").count()).toBeGreaterThanOrEqual(5);
    await expect(page.getByText("website").first()).toBeVisible();
    await expect(page.locator(".boot-splash")).toHaveCount(0);
    await expect(page).toHaveTitle("Collie");
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await expect(page.getByTestId("pane-view")).toBeVisible();
    await context.close();
  });

  test("(b) boot removes no element and draws no splash; (c) first tap; (d) back", async ({ page, context, baseURL }) => {
    // Hydration warnings and page errors only: the stub answers 404 for reads this spec does not need
    // (`/api/launchers`), as in every other spec.
    const problems: string[] = [];
    page.on("console", (msg) => {
      if (/hydrat/i.test(msg.text())) problems.push(msg.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await installRoutesApi(page, homeHandlers(() => SNAP));
    await useServerDocuments(context, baseURL!, SNAP);
    await watchMutations(page);
    await page.goto("/");
    await hydrated(page);
    const boot = await page.evaluate(() => ({ ...window.__ssrWatch }));
    console.log(`ssr-boot (b): boot added=${String(boot.added)} removed=${String(boot.removed)} text=${String(boot.textChanges)} splash=${String(boot.splash)} ${boot.removedWhat.join(", ")}`);
    expect(boot.splash).toBe(false);
    expect(boot.removed).toBe(0);
    expect(problems).toEqual([]);
    await expect(page).toHaveTitle("Collie");

    // (c) The first routed tap: the top frame builds its content root and replaces the island once.
    await page.evaluate(() => {
      Object.assign(window.__ssrWatch, { removed: 0, removedWhat: [], added: 0, textChanges: 0, clickAt: 0, paneAt: 0, armed: true });
    });
    await page.getByTestId("pane-row").first().click();
    await expect(page.getByTestId("pane-view")).toBeVisible();
    const tap = await page.evaluate(() => ({ ...window.__ssrWatch }));
    const ms = Math.round(tap.paneAt - tap.clickAt);
    console.log(`ssr-boot (c): first tap added=${String(tap.added)} removed=${String(tap.removed)} text=${String(tap.textChanges)} tap-to-pane=${String(ms)}ms ${tap.removedWhat.join(", ")}`);
    expect(tap.paneAt).toBeGreaterThan(0);
    expect(new URL(page.url()).pathname).toMatch(/^\/pane\//);

    // A second tap is the runtime's ordinary patching: back, then into the same pane again.
    // (d) Back returns to the dashboard.
    await page.goBack();
    await expect(page.getByTestId("home-scroller")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/");
    await expect(page.getByTestId("pane-row").first()).toBeVisible();
    await expect(page).toHaveTitle("Collie");
  });

  test("(b) a pane document hydrates with no mismatch and no splash", async ({ page, context, baseURL }) => {
    const problems: string[] = [];
    page.on("console", (msg) => {
      if (/hydrat/i.test(msg.text())) problems.push(msg.text());
    });
    page.on("pageerror", (error) => problems.push(error.message));
    await installRoutesApi(page, homeHandlers(() => SNAP));
    await useServerDocuments(context, baseURL!, SNAP);
    await watchMutations(page);
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    await hydrated(page);
    await expect(page.getByTestId("pane-view")).toBeVisible();
    const boot = await page.evaluate(() => ({ ...window.__ssrWatch }));
    console.log(`ssr-boot (b, pane): added=${String(boot.added)} removed=${String(boot.removed)} splash=${String(boot.splash)} ${boot.removedWhat.join(", ")}`);
    expect(boot.splash).toBe(false);
    expect(problems).toEqual([]);
  });

  test("(f) a tall dashboard keeps its scroll position across hydration", async ({ page, context, baseURL }) => {
    const tall = tallSnapshot();
    await installRoutesApi(page, homeHandlers(() => tall));
    await useServerDocuments(context, baseURL!, tall);
    // Hold the bundle, so the reader scrolls the server's document before any script runs.
    const gate = Promise.withResolvers<void>();
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      await gate.promise;
      await route.continue();
    });
    await page.goto("/", { waitUntil: "commit" });
    const scroller = page.getByTestId("home-scroller");
    await expect(scroller).toBeVisible();
    const before = await scroller.evaluate((el) => {
      el.scrollTop = 900;
      return { inner: el.scrollTop, max: el.scrollHeight - el.clientHeight, window: window.scrollY };
    });
    expect(before.max).toBeGreaterThan(900);
    expect(before.inner).toBe(900);
    gate.resolve();
    await hydrated(page);
    const after = await scroller.evaluate((el) => ({ inner: el.scrollTop, window: window.scrollY }));
    console.log(`ssr-boot (f): scrollTop before=${String(before.inner)} after=${String(after.inner)}; window ${String(before.window)} -> ${String(after.window)}`);
    expect(after.inner).toBe(900);
    expect(after.window).toBe(before.window);
  });
});

test.describe("static shell fallback", () => {
  test("(e) the static shell boots without the cookie, when the document answers 403, and offline", async ({ page, context, baseURL }) => {
    await installRoutesApi(page, homeHandlers(() => SNAP));
    // No cookie: the static shell, its splash, then the dashboard.
    await page.goto("/");
    await expect(page.getByTestId("pane-row").first()).toBeVisible();
    await expect(page.locator(".boot-splash")).toHaveCount(0);

    // Let the worker install and take the page, so the next navigations go through it.
    const controlled = await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (navigator.serviceWorker.controller === null) {
        await new Promise<void>((resolve) => {
          navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
          setTimeout(resolve, 10_000);
        });
      }
      return navigator.serviceWorker.controller !== null;
    });
    expect(controlled).toBe(true);

    // The document route refuses (403, as a proxy would): the worker answers with the precached shell.
    await context.addCookies([{ name: "e2e-ssr", value: "403", url: baseURL! }]);
    await page.reload();
    await expect(page.getByTestId("pane-row").first()).toBeVisible();
    expect(await page.evaluate(() => document.getElementById("rmx-data"))).toBeNull();

    // Offline: the precached shell at once, and the app boots on it.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("app-header").or(page.locator('[data-slot="app-header"]')).first()).toBeVisible();
    await expect(page.locator(".boot-splash")).toHaveCount(0, { timeout: 10_000 });
    await context.setOffline(false);
  });
});
