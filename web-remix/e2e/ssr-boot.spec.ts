import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { BridgeConfig, SnapshotResponse } from "@web/lib/types";

import { CONFIG, islandsOff } from "./fixtures";
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
//   (g) every island the document lists (`rmx-data`) has its module preloaded or already loaded
//   (h) no animation frame draws the body before the stylesheet applies, server document and static shell
//   (i) with JavaScript blocked, the splash and the pane's placeholder hide themselves by CSS after 8 s

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
  // This file pins the S1/S2 documents; e2e/islands.spec.ts holds the islands document (S3).
  await islandsOff(context, baseURL);
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

// (g) remix-store's lesson (research note 09, 2.5): an island whose module is not preloaded hydrates
// late and the server markup sits dead for a beat. `rmx-data` lists every island as `moduleUrl#exportName`.
// Ours are registry ids the entry bundle answers (`loadModule`, main.tsx), so for those the module is
// the document's entry script; a URL-shaped id must be a modulepreload or a script of the document.
// The runtime drops `rmx-data` once it has read it, so the spec reads it off the served HTML.

interface IslandEntry {
  moduleUrl?: string;
  exportName?: string;
}

function islandsOf(html: string): IslandEntry[] {
  const match = /<script type="application\/json" id="rmx-data">([\s\S]*?)<\/script>/u.exec(html);
  expect(match, "the document carries an rmx-data block").not.toBeNull();
  const data: { h?: Record<string, IslandEntry> } = JSON.parse(match![1]!);
  return Object.values(data.h ?? {});
}

/** Whether an island id names a file (a path or URL) and not an entry-bundle registry id. */
const isFileUrl = (moduleUrl: string): boolean => /^(?:\/|\.\/|https?:)/u.test(moduleUrl);

test.describe("server document islands", () => {
  test.use({ serviceWorkers: "block" });

  test("(g) every island in rmx-data has its module preloaded or already in the module map", async ({ page, context, baseURL }) => {
    await installRoutesApi(page, homeHandlers(() => SNAP));
    await useServerDocuments(context, baseURL!, SNAP);
    const html = await (await context.request.get(`${baseURL!}/`)).text();
    const islands = islandsOf(html);
    expect(islands.length).toBeGreaterThanOrEqual(1);

    await page.goto("/");
    await hydrated(page);
    const loaded = await page.evaluate(() => ({
      preloads: [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map((l) => new URL(l.href).pathname),
      scripts: [...document.querySelectorAll<HTMLScriptElement>("script[type=module][src]")].map((s) => new URL(s.src).pathname),
      fetched: performance.getEntriesByType("resource").map((r) => new URL(r.name).pathname),
    }));
    // The document's own module script is the entry bundle: it must be in the page AND have been fetched.
    expect(loaded.scripts.length).toBeGreaterThanOrEqual(1);
    for (const script of loaded.scripts) expect(loaded.fetched).toContain(script);

    for (const island of islands) {
      const id = `${island.moduleUrl ?? ""}#${island.exportName ?? ""}`;
      expect(island.moduleUrl, `island ${id} has a module`).toBeTruthy();
      expect(island.exportName, `island ${id} has an export`).toBeTruthy();
      if (!isFileUrl(island.moduleUrl!)) {
        // A registry id: answered by the entry bundle, which the assertions above proved loaded.
        expect(id).toBe("collie:app#AppRoot");
        continue;
      }
      const path = new URL(island.moduleUrl!, baseURL!).pathname;
      const preloaded = loaded.preloads.includes(path) || loaded.scripts.includes(path) || loaded.fetched.includes(path);
      expect(preloaded, `island module ${path} is preloaded or already fetched`).toBe(true);
    }
  });
});

// (h) The unstyled-frame detector: from `document_start` an animation-frame loop asks, each frame, whether
// the body has content while the stylesheet's token (`--background`, set on `:root` by the main CSS) is
// still missing. One such frame is a flash of unstyled content. The loop runs through the whole boot,
// and the spec also requires that it saw frames, so a loop that never ran cannot pass.

interface Frames {
  frames: number;
  withBody: number;
  unstyled: number;
  first: string;
}

declare global {
  interface Window {
    __frames?: Frames;
  }
}

async function watchStyledFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: Frames = { frames: 0, withBody: 0, unstyled: 0, first: "" };
    window.__frames = seen;
    const tick = (): void => {
      seen.frames++;
      const root = document.documentElement;
      const body = document.body;
      if (body !== null && body.firstElementChild !== null) {
        seen.withBody++;
        if (getComputedStyle(root).getPropertyValue("--background").trim() === "") {
          seen.unstyled++;
          if (seen.first === "") seen.first = `frame ${String(seen.frames)} at ${String(Math.round(performance.now()))} ms`;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

test.describe("unstyled frames", () => {
  test.use({ serviceWorkers: "block" });

  test("(h) the server document never draws a frame without its stylesheet", async ({ page, context, baseURL }) => {
    await installRoutesApi(page, homeHandlers(() => SNAP));
    await useServerDocuments(context, baseURL!, SNAP);
    await watchStyledFrames(page);
    await page.goto("/");
    await hydrated(page);
    const seen = await page.evaluate(() => window.__frames);
    console.log(`ssr-boot (h): frames=${String(seen?.frames)} with-body=${String(seen?.withBody)} unstyled=${String(seen?.unstyled)}`);
    expect(seen?.withBody ?? 0).toBeGreaterThan(0);
    expect(seen?.unstyled, seen?.first).toBe(0);
  });

  test("(h) the static shell never draws a frame without its stylesheet either", async ({ page }) => {
    await installRoutesApi(page, homeHandlers(() => SNAP));
    await watchStyledFrames(page);
    await page.goto("/");
    await expect(page.getByTestId("pane-row").first()).toBeVisible();
    const seen = await page.evaluate(() => window.__frames);
    expect(seen?.withBody ?? 0).toBeGreaterThan(0);
    expect(seen?.unstyled, seen?.first).toBe(0);
  });
});

// (i) CSS-ONLY EXIT (research note 09, D2.4). The 8 s is part of the contract, so the default is read
// off the computed style; the exit itself is watched with `--failsafe-delay`, a test-only custom
// property the stylesheet reads (index.html, src/app.css), set here by adding a rule to the served
// document, so the spec waits 0.6 s and not 8 s. JavaScript is OFF in these contexts: nothing but
// CSS can clear the placeholder.

const FAST = 600;

/** Serve every document with `--failsafe-delay` shortened. */
async function shortenFailsafe(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    const html = await response.text();
    return route.fulfill({ response, body: html.replace("</head>", `<style>:root{--failsafe-delay:${String(FAST)}ms}</style></head>`) });
  });
}

const visibility = (page: Page, selector: string): Promise<string> =>
  page.locator(selector).first().evaluate((el) => getComputedStyle(el).visibility);

test.describe("css-only exit", () => {
  test.use({ serviceWorkers: "block", javaScriptEnabled: false });

  test("(i) the static shell's splash is on for 8 s by default, and hides itself with no JavaScript", async ({ page }) => {
    await page.goto("/");
    const splash = page.locator(".boot-splash");
    await expect(splash).toBeVisible();
    const spec = await splash.evaluate((el) => {
      const style = getComputedStyle(el);
      return { delay: style.animationDelay, fill: style.animationFillMode, name: style.animationName };
    });
    expect(spec).toEqual({ delay: "8s", fill: "forwards", name: "boot-failsafe" });

    const fast = await page.context().newPage();
    await shortenFailsafe(fast);
    await fast.goto("/");
    await expect(fast.locator(".boot-splash")).toBeVisible();
    await expect.poll(() => visibility(fast, ".boot-splash"), { timeout: 5_000 }).toBe("hidden");
    await fast.close();
  });

  test("(i) a server-drawn pane placeholder hides itself with no JavaScript", async ({ page, context, baseURL }) => {
    await useServerDocuments(context, baseURL!, SNAP);
    await shortenFailsafe(page);
    await page.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    const skeleton = page.locator('[data-slot="screen-skeleton"]').first();
    await expect(skeleton).toBeAttached();
    expect(await skeleton.evaluate((el) => getComputedStyle(el).animationName)).toBe("placeholder-failsafe");
    await expect.poll(() => visibility(page, '[data-slot="screen-skeleton"]'), { timeout: 5_000 }).toBe("hidden");
    // The default, unshortened, is the same 8 s.
    const plain = await context.newPage();
    await plain.goto(`/pane/${encodeURIComponent("w1:p1")}`);
    expect(await plain.locator('[data-slot="screen-skeleton"]').first().evaluate((el) => getComputedStyle(el).animationDelay)).toBe("8s");
    await plain.close();
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
