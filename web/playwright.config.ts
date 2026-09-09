import { defineConfig } from "@playwright/test";

// The browser tier (M26). Vitest keeps every unit test; this config owns the ONE runner that opens
// the app in a real Chromium. Nothing here asserts a pixel: see `web/e2e/README` in the milestone
// docs and the rules in `CLAUDE.md`.
//
// Two axes, crossed into four projects: `app-phone`, `app-tablet`, `states-phone`, `states-tablet`.
//   * A TARGET is a base URL plus a fixture story. `app` is the shipped bundle from `web/dist`,
//     served statically, with every `/api/*` answered in-process by `e2e/fixtures/api.ts`. `states`
//     is the playground on 5199, reached the way `make playground` reaches it, with no API stub at
//     all — `vite.config.ts`'s `playgroundOnlyPlugin` answers every `/api/*` with a 404 itself.
//   * A VIEWPORT is a size. `phone` and `tablet` are the two, and every case runs at both unless it
//     names one.
//
// `states-*` collects only `states.spec.ts` and `handles.spec.ts` (`STATES_TEST_MATCH`); `app-*`
// collects everything else. Neither set of specs can run under the other target: the shipped bundle
// has no playground, and the playground has no `/api/*`.
//
// Only Chromium. One engine, one download, one cache key.

/** The phone. 390x844 is the iPhone 14/15 CSS size. */
const PHONE = { width: 390, height: 844 } as const;
/** The tablet. 820x1180 is the iPad 10th generation CSS size, the one the layout shots already use. */
const TABLET = { width: 820, height: 1180 } as const;

/**
 * The `app` target's static server. 4173 is Vite's own preview port and collides with no Collie
 * instance (8787-8790, 8799, 5198, 5199).
 *
 * SECURE CONTEXT, checked first-hand on 2026-09-09 with this config, Playwright 1.62.1 and its
 * bundled headless Chromium 151.0.7922.34:
 * `http://127.0.0.1:4173` IS a secure context. `window.isSecureContext` is `true`,
 * `"serviceWorker" in navigator` is `true`, and `navigator.serviceWorker.register("/sw.js")`
 * resolves with an active worker. Chromium treats a loopback literal as a potentially trustworthy
 * origin (W3C secure-contexts §5.2), so no TLS and no `--unsafely-treat-insecure-origin-as-secure`
 * flag is needed. The bare hostname `localhost` would work for the same reason; the literal is used
 * because it never depends on a resolver. This is why the service-worker cases can live in this
 * tier at all.
 */
const APP_PORT = 4173;
const APP_BASE_URL = `http://127.0.0.1:${APP_PORT}`;

/**
 * The `states` target's playground. 5199 is `make playground`'s own port
 * (`web/package.json`'s `playground` script), and it never collides with an instance for the
 * same reason `make playground-up` already checks for it. `COLLIE_PLAYGROUND=1` makes
 * `vite.config.ts`'s `playgroundOnlyPlugin` answer every `/api/*` with a 404 in-process, so this
 * target carries no API stub at all.
 */
const STATES_PORT = 5199;
const STATES_BASE_URL = `http://127.0.0.1:${STATES_PORT}`;

/** The `states` target owns exactly two spec files: the named playground cases (spec 03) and the
 *  handle roll call (spec 02). An `app-*` project must never collect either. */
const STATES_TEST_MATCH = [/states\.spec\.ts$/, /handles\.spec\.ts$/];

/** Tier 2 lives under `e2e/live/**` and has its own config (`e2e/live/playwright.config.ts`).
 *  It needs the live dev lane, so tier 1 never collects it; `make e2e` runs tier 2. */
const LIVE_TEST_IGNORE = "**/live/**";

export default defineConfig({
  // Outside `src/`, so `vitest.config.ts:30` (`include: ["src/**/*.{test,spec}.{ts,tsx}"]`) collects
  // none of these and neither runner ever sees the other's files.
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry in CI, none locally: `trace: "on-first-retry"` only produces a trace when a retry
  // exists, and a flake that reproduces locally should reproduce on the first run.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // `list` for the log, `html` for the report the CI job uploads on a failure. Never opened
  // automatically: an `open: "always"` here would hang a headless runner waiting on a browser.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: APP_BASE_URL,
    // Evidence for a human after a failure, never a baseline to compare against. No pixel is ever
    // asserted in this tier: there are no baseline images and there is not meant to be. A baseline
    // suite would be the flakiest thing in this repo and would fail on a font substitution.
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "off",
  },
  projects: [
    {
      name: "app-phone",
      use: { browserName: "chromium", viewport: PHONE, hasTouch: true, deviceScaleFactor: 2 },
      // The `app` target owns every spec EXCEPT the states target's two: the shipped bundle has
      // no playground and cannot answer them.
      testIgnore: [...STATES_TEST_MATCH, LIVE_TEST_IGNORE],
    },
    {
      name: "app-tablet",
      use: { browserName: "chromium", viewport: TABLET, hasTouch: true, deviceScaleFactor: 2 },
      testIgnore: [...STATES_TEST_MATCH, LIVE_TEST_IGNORE],
    },
    {
      name: "states-phone",
      use: {
        browserName: "chromium",
        viewport: PHONE,
        hasTouch: true,
        deviceScaleFactor: 2,
        baseURL: STATES_BASE_URL,
      },
      testMatch: STATES_TEST_MATCH,
      testIgnore: LIVE_TEST_IGNORE,
    },
    {
      name: "states-tablet",
      use: {
        browserName: "chromium",
        viewport: TABLET,
        hasTouch: true,
        deviceScaleFactor: 2,
        baseURL: STATES_BASE_URL,
      },
      testMatch: STATES_TEST_MATCH,
      testIgnore: LIVE_TEST_IGNORE,
    },
  ],
  webServer: [
    {
      // The SHIPPED bundle off disk, not `vite dev`: the service worker exists only in a real build
      // (`vite.config.ts` sets `devOptions: { enabled: false }`), so a dev server would test a
      // different app. `bun run e2e` runs `vite build` before this starts.
      command: `bunx vite preview --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      url: APP_BASE_URL,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // The playground, started exactly the way `make playground` starts it
      // (`web/package.json`'s `playground` script). Reused locally so a developer's own `bun run
      // playground` on 5199 is picked up instead of fighting it for the port; NEVER reused in CI,
      // where no such server exists and a stale one must not be trusted.
      command: "bun run playground",
      url: STATES_BASE_URL,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
      timeout: 60_000,
    },
    {
      // M26/04, the SWAPPABLE bundle server on 4174. It builds `e2e/.builds/a` and `e2e/.builds/b`
      // before it listens (hence the long timeout) and serves whichever of the two
      // `e2e/.builds/serving` names, so `e2e/service-worker.spec.ts` can deploy a new bundle under a
      // browser that is already running one. Its own port because a service worker's scope is an
      // ORIGIN: a swap on 4173 would be a spooky action on every other case.
      command: "bun e2e/serve-builds.ts",
      url: "http://127.0.0.1:4174/",
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 180_000,
    },
  ],
});
