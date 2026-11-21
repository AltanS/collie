import { expect, test, type Page } from "@playwright/test";

import { PRELOAD_RELOAD_KEY } from "@/lib/chunk-reload";
import { en } from "@/lib/i18n/messages/en";

import { installApiStub } from "./fixtures/api";
import { SCREENS } from "./screens/list";

// THE SCREENS THAT LOAD ON DEMAND STILL OPEN WITH THE NETWORK OFF (ADR 0169).
//
// The route table (src/router.tsx) loads most screens on demand, and the app fetches every one of them in the
// background once it is idle (src/lib/route-preload.ts). The claim here: after one online load and that idle
// moment, the tab holds every lazy screen, so each one opens offline with no request for a chunk. The worker is
// blocked on purpose: the claim is about the page's own memory, not the precache, which `service-worker.spec.ts`
// owns. A chunk the preload missed would need the network, fail, and land on the error screen or a reload.
//
// The list comes from the screen list (e2e/screens/list.ts), which `src/screens-list.test.ts` keeps complete
// against the router: every route that is not one of the eager few below is lazy (`src/router-lazy.test.ts`
// holds the table to that), so a new lazy route is visited here without a second list.

test.use({ serviceWorkers: "block" });

/** The routes a first paint needs, and Pair approve: in the main chunk, never lazy. */
const EAGER = new Set(["/", "slot/:slot", "space/:spaceId", "trick/:paneId", "pair/approve", "pane/:paneId", "pane/:paneId/zoom"]);

/** One path per lazy route, the screen list's first entry for it. */
const LAZY_PATHS = [...new Map(SCREENS.filter((s) => !EAGER.has(s.route)).map((s) => [s.route, s.path])).values()];

/**
 * Hold the app's reload latch (lib/chunk-reload.ts, `PRELOAD_RELOAD_KEY`), so no chunk miss can reload the page.
 * Some screens reach an older door offline (the theme marks and the speech engine stay out of memory until used):
 * with the latch held such a miss falls back as it does after a recent reload. And a lazy screen the preload had
 * not taken would end on the error screen instead of a reload, which this case asserts against.
 */
async function holdReloadLatch(page: Page): Promise<void> {
  await page.evaluate((key) => sessionStorage.setItem(key, String(Date.now())), PRELOAD_RELOAD_KEY);
}

/** Every script the page fetched so far: the main chunk, its siblings and every chunk the preload took. */
function scriptCount(page: Page): Promise<number> {
  return page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js")).length);
}

/** Wait until the background preload is done: past its idle moment, and no new script for a second. */
async function waitForPreload(page: Page): Promise<void> {
  await page.waitForTimeout(2_500);
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await scriptCount(page);
        const settled = now === last;
        last = now;
        return settled;
      },
      { intervals: [1_000], timeout: 20_000 },
    )
    .toBe(true);
}

/** Open `path` in this page's router, as a tap does, with no document load. */
async function openInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState(null, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test("every lazy screen opens offline after one online load", async ({ page, context }) => {
  test.setTimeout(120_000);
  expect(LAZY_PATHS.length).toBeGreaterThan(20);
  await installApiStub(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] })).toBeVisible();
  await waitForPreload(page);

  // A reload would clear this mark; the page must stay the one that preloaded.
  await page.evaluate(() => Object.assign(window, { lazyScreensMark: true }));
  // The app's own chunks live under `/assets/`. The folders out of the precache (fonts, marks, glyphs, math, the
  // speech engine) are their own doors and not this case's claim.
  // The older doors under `/assets/` (src/lazy-imports.test.ts lists them) load on use and are not preloaded; the
  // speech engine is the one a screen here asks for (Settings, Voice). In real use the precache answers it.
  const OLDER_DOOR = /\/assets\/(?:stt-engine|diff-highlight-engine|report-sheet|math-markup)-/;
  const chunks: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (new URL(url).pathname.startsWith("/assets/") && !OLDER_DOOR.test(url)) chunks.push(url);
  });
  await context.setOffline(true);

  for (const path of LAZY_PATHS) {
    await holdReloadLatch(page);
    // The app's root, not `main`: some screens (History) draw no main region.
    const before = await page.locator("#root").innerText();
    await openInApp(page, path);
    // React Router keeps the old screen until the lazy one is in; the new screen's text is the proof it drew.
    await expect.poll(async () => (await page.locator("#root").innerText()) !== before, { message: path, timeout: 5_000 }).toBe(true);
    await expect(page.getByText(en["error.root.title"]), path).toHaveCount(0);
    expect(await page.evaluate(() => "lazyScreensMark" in window), `${path}: the page reloaded`).toBe(true);
  }
  expect(chunks, "no chunk was fetched while offline").toEqual([]);
});

test("a cold deep link to Settings shows the boot screen, then the page", async ({ page }) => {
  await installApiStub(page);
  // Hold the Settings chunks, so the wait is long enough to see what a person sees during it.
  const waiting: (() => void)[] = [];
  const held = new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
  await page.route("**/assets/settings-*.js", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/settings");
  await expect(page.getByText(en["error.boot.connecting"])).toBeVisible();
  for (const release of waiting) release();
  await expect(page.getByRole("heading", { name: en["settings.title"] }).first()).toBeVisible();
  await expect(page.getByText(en["error.root.title"])).toHaveCount(0);
});
