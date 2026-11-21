import { defineConfig, devices, type PlaywrightTestConfig } from "@playwright/test";

import { stillMarkState } from "./e2e/fixtures/still-mark";

// The browser tier (M26). Vitest keeps every unit test that jsdom can run; this config owns the ONE
// runner that opens the app in a real browser engine, and its specs are the ones that need an engine
// (first paint before JS, real layout, a service worker, a CSP, real transitions). Nothing here
// asserts a pixel: see `web/e2e/README` in the milestone docs and the rules in `CLAUDE.md`.
//
// Two axes, crossed into two projects: `app-phone` and `app-tablet`.
//   * The TARGET is a base URL plus a fixture story. `app` is the shipped bundle from `web/dist`,
//     served statically, with every `/api/*` answered in-process by `e2e/fixtures/api.ts`. (A second
//     target, `states`, ran the playground on 5199 for `handles.spec.ts`; that spec moved to vitest
//     and the target went with it.)
//   * A VIEWPORT is a size. `phone` and `tablet` are the two, and every case runs at both unless it
//     names one.
//
// Chromium, plus WebKit on the `app` target at phone size. Safari is where a phone actually opens
// Collie, and it disagrees with Chromium on things a unit test never sees: on 2026-09-14 the
// composer's belt held 6px of vertical overflow that Chromium clipped and WebKit let a thumb scroll.
// `app-phone-webkit` collects the same specs as `app-phone` and exists so that class of bug fails in
// CI. It is OPT-IN off CI: Playwright's WebKit build links against Ubuntu's libraries, so on Fedora
// (this workspace's host) it cannot launch at all, and a developer's `bun run e2e` must not fail on
// that. `COLLIE_E2E_WEBKIT=1` turns it on locally; `make e2e-webkit` at the workspace root runs it
// inside an Ubuntu distrobox for exactly that host. In CI the runner IS Ubuntu, so it is on, except
// in the per-push job in `ci.yml`, which sets `E2E_WEBKIT=0` and runs Chromium only. WebKit runs
// nightly and at a release tag, in `.github/workflows/webkit.yml`.
//
// Two SETS of specs, picked by `E2E_SET` (2026-10-17). Unset runs everything, so a developer's
// `bun run e2e` and `webkit.yml` are unchanged. `ci.yml` splits the per-push browser job in two:
// `E2E_SET=rest` runs every spec but the two swap-server ones, `E2E_SET=swap` runs only
// `service-worker.spec.ts` and `update-screen.spec.ts`. Those two move one shared pointer
// (`holdSwapServer`, `e2e/fixtures/builds.ts`), so they run one case at a time and were the
// critical path of the single job: about 3.3 min alone, about 6.7 min when a flake re-ran the
// whole serial chain. Apart, the rest of the tier (about 280 s of test time) no longer waits behind
// them. The sets also decide which `webServer` entries start: only the swap set needs 4174 (it
// builds two extra bundles), and only the rest set needs 4173 and 4175.

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
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4173);
const APP_BASE_URL = `http://127.0.0.1:${APP_PORT}`;
// `E2E_APP_PORT` moves the app target off 4173 (2026-11-21). Several worktrees run this tier on one machine, and
// `reuseExistingServer` would hand a run the OTHER worktree's `vite preview`, its bundle and not this one.

/** Tier 2 lives under `e2e/live/**` and has its own config (`e2e/live/playwright.config.ts`).
 *  It needs the live dev lane, so tier 1 never collects it; `make e2e` runs tier 2. The browser leg
 *  under `e2e/rig/**` has its own config too: it starts a scratch bridge and real agents. */
/** The real-touch specs (`*.touch.spec.ts`, CDP multi-touch) never gate: they are collected only with
 *  `COLLIE_E2E_TOUCH=1`, so no default project, CI job or `bun run e2e` runs them. */
const TOUCH_IGNORE = process.env.COLLIE_E2E_TOUCH === "1" ? [] : ["**/*.touch.spec.ts"];
const LIVE_TEST_IGNORE = ["**/live/**", "**/rig/**", ...TOUCH_IGNORE];

/** WebKit runs in CI unless `E2E_WEBKIT=0` (the per-push job sets it, `webkit.yml` does not) and only
 *  on request elsewhere; the header says why. */
const WEBKIT =
  process.env.E2E_WEBKIT === "0"
    ? false
    : Boolean(process.env.CI) || process.env.COLLIE_E2E_WEBKIT === "1";

/** The specs that deploy bundles under a running browser, through the lock in
 *  `e2e/fixtures/builds.ts`. All use `SWAP_BASE_URL` (4174) and no other server. */
const SWAP_SPECS = ["**/service-worker.spec.ts", "**/update-screen.spec.ts", "**/swap-lazy-screen.spec.ts"];

/** The screen list's own spec (`e2e/screens.spec.ts`): one page per entry of `e2e/screens/list.ts`. It is in
 *  no other set, so only `E2E_SET=screens` runs it. */
const SCREENS_SPEC = "**/screens.spec.ts";

/** R5 `contrast`, the screen list in every theme (`e2e/themes.spec.ts`), in no other set: only `E2E_SET=themes` runs it. */
const THEMES_SPEC = "**/themes.spec.ts";

/** Which specs this run collects: `swap`, `rest`, `screens`, `themes`, or (unset) swap and rest. Anything else is a typo,
 *  and a typo that silently ran nothing would read as a green run. */
const E2E_SET = process.env.E2E_SET;
if (E2E_SET !== undefined && E2E_SET !== "" && E2E_SET !== "swap" && E2E_SET !== "rest" && E2E_SET !== "screens" && E2E_SET !== "themes") {
  throw new Error(`E2E_SET must be "swap", "rest", "screens", "themes" or unset, got "${E2E_SET}"`);
}
const RUN_SCREENS = E2E_SET === "screens";
const RUN_THEMES = E2E_SET === "themes";
const RUN_SWAP = E2E_SET !== "rest" && !RUN_SCREENS && !RUN_THEMES;
const RUN_REST = E2E_SET !== "swap" && !RUN_SCREENS && !RUN_THEMES;
/** The specs that run only in a set of their own. */
const OWN_SETS = [SCREENS_SPEC, THEMES_SPEC];

/** The spec selection every project shares: never the tier-2 specs, plus the set filter. */
const SPECS = RUN_SCREENS
  ? { testIgnore: LIVE_TEST_IGNORE, testMatch: [SCREENS_SPEC] }
  : RUN_THEMES
    ? { testIgnore: LIVE_TEST_IGNORE, testMatch: [THEMES_SPEC] }
    : RUN_REST
      ? { testIgnore: RUN_SWAP ? [...LIVE_TEST_IGNORE, ...OWN_SETS] : [...LIVE_TEST_IGNORE, ...OWN_SETS, ...SWAP_SPECS] }
      : { testIgnore: LIVE_TEST_IGNORE, testMatch: SWAP_SPECS };

type WebServer = Exclude<PlaywrightTestConfig["webServer"], unknown[] | undefined>;

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
    // THE CHARACTER HOLDS STILL. The header character drifts at rest whenever the page is visible, and a
    // page that moves asks the engine for a frame at every vsync (WebKit ran multi-page cases 1.5 to 3
    // times slower for it in 1.28.1). Every case runs with the device's own switch off, on each origin
    // this config serves (4173 the app, 4174 the swap server, 4175 the mounted bundle). A case that
    // writes its own design blob spreads `STILL_MARK`; a case that makes its own context passes
    // `stillMarkState`; `e2e/mark-moves.spec.ts` is the one that turns the motion on. See
    // `e2e/fixtures/still-mark.ts` for why this is not `reducedMotion`.
    storageState: stillMarkState(APP_BASE_URL, "http://127.0.0.1:4174", "http://127.0.0.1:4175"),
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
      ...SPECS,
    },
    {
      name: "app-tablet",
      use: { browserName: "chromium", viewport: TABLET, hasTouch: true, deviceScaleFactor: 2 },
      ...SPECS,
    },
    // The Safari engine, same specs as `app-phone`. Spread so the project is simply absent, not
    // skipped, when it is off: an absent project never asks for a browser that is not there.
    // THE DEVICE DESCRIPTOR IS LOAD-BEARING. `devices["iPhone 13"]` sets `isMobile: true`, a
    // mobile user agent and `hasTouch`, on top of WebKit. A bare `{ browserName: "webkit",
    // viewport: PHONE }` is WebKit in desktop mode at a phone's width, and on 2026-09-14 that
    // combination HUNG the app at `/pane/<id>`: `page.evaluate` never returned, the first-run
    // dialog never appeared. No real phone is a desktop Safari at 390px, so the descriptor is the
    // honest configuration, and the hang stays a note here until someone wants to chase it. The
    // viewport is re-stated so both phone projects measure the same 390x844.
    ...(WEBKIT
      ? [
          {
            name: "app-phone-webkit",
            use: { ...devices["iPhone 13"], viewport: PHONE },
            ...SPECS,
          },
        ]
      : []),
  ],
  // Each entry starts only for the set that has a client; see the note on `E2E_SET` at the top.
  webServer: [
    ...(RUN_REST || RUN_SCREENS || RUN_THEMES
      ? [
        {
          // The SHIPPED bundle off disk, not `vite dev`: the service worker exists only in a real build
          // (`vite.config.ts` sets `devOptions: { enabled: false }`), so a dev server would test a
          // different app. `bun run e2e` runs `vite build` before this starts.
          command: `bunx vite preview --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
          // THE PROXY POINTS NOWHERE. `vite preview` inherits `server.proxy` (Vite resolves
          // `preview.proxy ?? server.proxy`), so an `/api/*` request the fixture never sees goes to
          // `COLLIE_DEV_TARGET`, 127.0.0.1:8787 by default: on the workspace host that is the LIVE
          // release lane. The fixture misses a request when a service worker has claimed the page (the
          // cases that do not need one run with `serviceWorkers: "block"`) and, under WebKit, when a poll
          // is still in flight as the page closes. On 2026-09-27 the first kind read the release lane's
          // real snapshot and pane list in a composer case. Port 9 has no listener, so a missed request gets Vite's own
          // 502 here, the same answer CI gives, and never reaches a bridge.
          env: { COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
          url: APP_BASE_URL,
          reuseExistingServer: !process.env.CI,
          stdout: "ignore",
          stderr: "pipe",
          timeout: 60_000,
        },
      ] satisfies WebServer[]
      : []),
    // The screen list's set and the themes set need the app on 4173 and nothing else.
    ...(RUN_REST
      ? [
        {
          // M57, the MOUNTED bundle server on 4175: `web/dist` through the bridge's own `serveStatic`
          // under `COLLIE_BASE_PATH=/collie/`. `e2e/theme-first-paint.spec.ts` is its one client. No
          // API at all; a case that needs one belongs on 4173.
          command: "bun e2e/serve-mount.ts",
          url: "http://127.0.0.1:4175/collie/",
          reuseExistingServer: !process.env.CI,
          stdout: "ignore",
          stderr: "pipe",
          timeout: 60_000,
        },
        {
          // The DESIGN REFERENCE on 4176, Vite's dev server under `COLLIE_PLAYGROUND=1` (no bridge: every
          // `/api/*` answers 404 from the playground plugin, vite.config.ts). Its phone frames carry a
          // transform, as the website's do, and `e2e/wide-sheets.spec.ts` checks that a sheet in one stays
          // a bottom sheet in a wide window. Its own port: 5199 is the always-on design app.
          command: "bunx vite --host 127.0.0.1 --port 4176 --strictPort",
          env: { COLLIE_PLAYGROUND: "1", COLLIE_DEV_TARGET: "http://127.0.0.1:9" },
          url: "http://127.0.0.1:4176/design.html",
          reuseExistingServer: !process.env.CI,
          stdout: "ignore",
          stderr: "pipe",
          timeout: 60_000,
        },
      ] satisfies WebServer[]
      : []),
    ...(RUN_SWAP
      ? [
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
      ] satisfies WebServer[]
      : []),
  ],
});
