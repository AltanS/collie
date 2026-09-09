import { expect, test } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { fixtureWorkspaces } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";

// The one case that must never be skipped. It asserts no feature: it proves the PATH — a real
// `vite build`, a static server over `web/dist`, the API stub, both viewports, and the artefact
// wiring on a failure. Every later case leans on all five.
//
// Selectors are a role and an accessible name, never a CSS class, and the name comes from the app's
// own English dictionary, so a copy edit moves this test with it.

test.beforeEach(async ({ page }) => {
  await installApiStub(page);
});

test("the app shell renders on /", async ({ page }) => {
  await page.goto("/");

  // The shell, by role and accessible name: the header's home button (`components/collie-home.tsx`,
  // whose aria-label IS this string) and the route's main region. Both are mounted once for the
  // life of the app, so this is the handle that says "the bundle booted", not "home happened to
  // render".
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] })).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();

  // And the shell is showing FIXTURE data, so the stub was reached and `rootLoader` resolved. A
  // workspace label out of `fixtureSnapshot` is the shortest proof of that.
  await expect(page.getByText(fixtureWorkspaces[0]!.label, { exact: false }).first()).toBeVisible();
});

// The reason the service-worker cases can live in this tier at all. Recorded as a case rather than
// only as a comment in the config, so a Chromium change that revokes it fails the suite instead of
// quietly making a later spec meaningless.
test("loopback over plain HTTP is a secure context, so the service worker can register", async ({
  page,
}) => {
  await page.goto("/");

  const secure = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasServiceWorker: "serviceWorker" in navigator,
    origin: window.location.origin,
  }));

  expect(secure.origin).toContain("127.0.0.1");
  expect(secure.isSecureContext).toBe(true);
  expect(secure.hasServiceWorker).toBe(true);

  // Not just permitted — actually installed. The bundle registers `/sw.js` itself
  // (`vite.config.ts`, `injectRegister: false` plus `src/lib/pwa.ts`), so waiting on the
  // registration proves the shipped worker, not a test-only one.
  const scope = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.scope;
  });
  expect(scope).toContain("127.0.0.1");
});
