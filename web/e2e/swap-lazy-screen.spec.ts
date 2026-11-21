import { readdirSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { SERVER_BUILD_HEADER } from "@/lib/server-build";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import {
  BUILDS_DIR,
  SWAP_BASE_URL,
  clearDelay,
  clearFail,
  clearThrottle,
  holdSwapServer,
  readBuildStamp,
  readEntryScript,
  releaseSwapServer,
  serveBuild,
} from "./fixtures/builds";

// A LAZY SCREEN OPENS IN A TAB THAT HELD ITS RELOAD THROUGH AN UPDATE (ADR 0169).
//
// The case the split could break. A page on build A holds an unsent draft, so the new worker's
// `controllerchange` cannot reload it (lib/pwa.ts `reloadWhenReleased`). The new worker has dropped build A's
// chunks from the precache and the server answers them 404. The page then opens Settings → Look and feel, a lazy
// screen. The idle preload already holds its chunk, so the screen draws and the error screen never shows;
// leaving the pane clears the draft's hold, and the deferred reload then lands the page on build B. Without the
// preload the import would fail while the hold stands: the error screen first, then the same reload.
//
// Next to `service-worker.spec.ts`, on the same swappable server (`e2e/serve-builds.ts`) and the same lock.

const PHONE_PROJECTS = new Set(["app-phone", "phone"]);

/** The Look and feel page's chunk of one build, by its hashed name. */
function settingsChunk(name: "a" | "b"): string {
  const file = readdirSync(join(BUILDS_DIR, name, "assets")).find((f) => /^settings-sections-.*\.js$/.test(f));
  if (file === undefined) throw new Error(`build ${name} has no settings-sections chunk`);
  return `/assets/${file}`;
}

/** Every script the page fetched; the background preload is done when this stops growing. */
async function waitForPreload(page: Page): Promise<void> {
  await page.waitForTimeout(2_500);
  let last = -1;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => performance.getEntriesByType("resource").filter((e) => e.name.endsWith(".js")).length);
        const settled = now === last;
        last = now;
        return settled;
      },
      { intervals: [1_000], timeout: 20_000 },
    )
    .toBe(true);
}

let stampedBuildId = "";

test.use({ baseURL: SWAP_BASE_URL });
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(!PHONE_PROJECTS.has(testInfo.project.name), "the service worker has no viewport");
  test.setTimeout(0);
  const queued = await holdSwapServer();
  test.setTimeout(120_000 + queued);
  clearDelay();
  clearFail();
  clearThrottle();
  serveBuild("a");
  stampedBuildId = readBuildStamp("a").id;
  await installApiStub(page);
  await page.route(/\/api\/snapshot/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { [SERVER_BUILD_HEADER]: stampedBuildId },
      body: JSON.stringify(fixtureSnapshot),
    }),
  );
  // The API-observed self-updater is a second trigger; spend its once-per-build key, as service-worker.spec.ts does.
  const spent = (["a", "b"] as const).map((n) => `collie:auto-reloaded-for=${readBuildStamp(n).id}`);
  await page.addInitScript((keys: string[]) => {
    for (const key of keys) window.sessionStorage.setItem(key, "e2e");
  }, spent);
  // Record whether the error screen is ever drawn, from the first script on.
  await page.addInitScript((title: string) => {
    new MutationObserver(() => {
      if (document.body?.textContent?.includes(title) === true) window.sessionStorage.setItem("e2e:saw-error", "1");
    }).observe(document, { childList: true, subtree: true, characterData: true });
  }, en["error.root.title"]);
});

test.afterEach(() => {
  releaseSwapServer();
});

test("a tab that held its reload through an update still opens a lazy screen", async ({ page }) => {
  const [oldChunk, newChunk] = [settingsChunk("a"), settingsChunk("b")];
  expect(oldChunk, "the two builds must name the Settings chunk differently, or the case proves nothing").not.toBe(newChunk);

  // Build A, controlled by its worker, the preload done.
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.goto("/pane/w1:p1");
  await waitForPreload(page);
  expect(await page.evaluate(() => [...document.scripts].some((s) => s.src.includes("/assets/index-")))).toBe(true);

  // The draft holds the reload.
  await page.getByRole("textbox", { name: en["composer.placeholder.reply"] }).fill("a draft the update must not eat");
  const firstWorker = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL ?? "");

  // The swap: the bridge names build B and serves its files; the page finds the new worker.
  stampedBuildId = readBuildStamp("b").id;
  serveBuild("b");
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update());
  // Build A's Settings chunk is gone from the precache and from the server.
  await expect
    .poll(() => page.evaluate(async (url) => (await caches.match(url)) === undefined, oldChunk), { timeout: 30_000 })
    .toBe(true);
  expect(await page.evaluate(async (url) => (await fetch(url, { cache: "no-store" })).status, oldChunk)).toBe(404);
  expect(firstWorker).not.toBe("");
  // Still build A: the draft held the reload.
  expect(await page.evaluate(() => document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src ?? "")).toContain(
    readEntryScript("a"),
  );
  await expect(page.getByRole("textbox", { name: en["composer.placeholder.reply"] })).toHaveValue("a draft the update must not eat");

  // Open Settings → Look and feel in the app, as a tap does.
  await page.evaluate(() => {
    window.history.pushState(null, "", "/settings/look");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByRole("heading", { name: en["settings.page.look.title"] }).first()).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => window.sessionStorage.getItem("e2e:saw-error")), "the error screen was drawn").toBeNull();
});
