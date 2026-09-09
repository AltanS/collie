import { defineConfig } from "@playwright/test";

// The browser tier (M26). Vitest keeps every unit test; this config owns the ONE runner that opens
// the app in a real Chromium. Nothing here asserts a pixel: see `web/e2e/README` in the milestone
// docs and the rules in `CLAUDE.md`.
//
// Two axes:
//   * A TARGET is a base URL plus a fixture story. `app` is the shipped bundle from `web/dist`,
//     served statically, with every `/api/*` answered in-process by `e2e/fixtures/api.ts`.
//     The `states` target — the playground on 5199 — lands in spec 02; its slot is marked below.
//   * A VIEWPORT is a size. `phone` and `tablet` are the two, and every case runs at both unless it
//     names one.
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
      name: "phone",
      use: { browserName: "chromium", viewport: PHONE, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: "tablet",
      use: { browserName: "chromium", viewport: TABLET, hasTouch: true, deviceScaleFactor: 2 },
    },
    // SLOT: `states-phone` and `states-tablet` — the playground target — land in spec 02. They take
    // the same two viewports with `baseURL: "http://127.0.0.1:5199"` and no API stub at all
    // (`vite.config.ts:41-61` answers every `/api/*` with a 404 under `COLLIE_PLAYGROUND=1`).
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
    // SLOT: the playground on 5199, started the way `make playground` starts it, lands in spec 02.
  ],
});
