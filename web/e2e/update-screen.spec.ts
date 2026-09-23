import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { SERVER_BUILD_HEADER } from "@/lib/server-build";
import { fixtureSnapshot } from "@/test/handlers";
import type { UpdateCrewMember, UpdateInfo, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";

import { fill, installApiStub } from "./fixtures/api";
import {
  SWAP_BASE_URL,
  clearDelay,
  clearFail,
  clearThrottle,
  readBuildStamp,
  readEntryScript,
  serveBuild,
  setThrottle,
} from "./fixtures/builds";

// THE UPDATE IN PROGRESS TAKES THE SCREEN, IN A REAL BROWSER (M28/01, update mode since ADR 0064).
//
// Two cases over the one path no unit test can reach. The reducer's own cross-product is pinned in
// `src/lib/update-screen.test.ts`, and the sheet's DOM in `src/components/update-screen.test.tsx`;
// what only a browser can show is the three things that are not functions of an input:
//
//   1. `inert` on the wrapper in `App.tsx` actually takes the app behind out of reach;
//   2. the file count on this device's own row comes off a REAL service-worker precache of a REAL new
//      bundle, one message per completed asset (`src/sw.ts`);
//   3. the page reloads ONCE, on the controller swap, and the document that boots reopens update mode
//      on Done, because the claim outlived the page. `update-screen.spec.ts` measures the panel's boxes.
//
// THE SWAP SERVER, NOT `vite preview`. The bundle has to change under a browser that is already
// running one, which is what `e2e/serve-builds.ts` is for, and a swap is destructive to every other
// case on the origin — a service worker's scope is an ORIGIN, so the second port is the only clean
// separation. The same reasoning as `e2e/service-worker.spec.ts`, whose shape this file follows.
//
// THE RUN IS A FAKE API AND NOTHING ELSE. `POST /api/update` on a real bridge detaches a process that
// rebuilds and restarts the host; a browser case must never be the thing that does that. So the run
// record is a variable in this file, walked through its states by the case, and `GET /api/update/check`
// plus `GET /standby/update` both report it. That is exactly what the phone sees.

/** The projects this file runs in: the phone, on the `app` target. A sheet has a viewport, but a
 *  service-worker precache of two real bundles does not get faster at the tablet size. */
const PHONE_PROJECTS = new Set(["app-phone", "phone"]);
/** The no-shift walk runs in Safari's engine as well: geometry is where the two engines disagree. */
const NO_SHIFT_PROJECTS = new Set([...PHONE_PROJECTS, "app-phone-webkit"]);
const NO_SHIFT_TITLE = "every state of update mode keeps the panel's boxes where they were";

/** The versions the fake run moves between. Above this bundle's own, so this phone has a step 6. */
const FROM = "1.12.0";
const TO = "1.13.0";
/** The card's action button, and "Start update" on update mode's first screen (ADR 0064). */
const UPDATE_ACTION = fill(en["settings.updateCard.action"], { version: TO });
const CONFIRM = en["updateScreen.action.start"];
/** The lock line the panel shows while a run this device started is in flight. */
const LOCK = en["updateScreen.lock"];
const DONE = en["updateScreen.done.heading"];
const BACK = en["updateScreen.action.back"];
/** The crew-only case's button (M32): it names the one member it is for. */
const RETRY_CREW = fill(en["settings.updateCard.retryOne"], { name: "minibuch" });

/** Where the reload counter lives. Read back after a navigation, so `sessionStorage`. */
const RELOADS_KEY = "e2e:reloads";

test.use({ baseURL: SWAP_BASE_URL });

// SERIAL: one origin, one service-worker scope, one served-directory pointer. Two of these at once
// would be two deploys landing on each other.
test.describe.configure({ mode: "serial" });

/** The run this "bridge" is reporting right now. One assignment is one step of the run. */
let currentRun: UpdateRun | null = null;
/** The build id stamped on every snapshot response. One assignment is one deploy. */
let stampedBuildId = "";
/**
 * Which lead this "bridge" is (M32). `behind` has a release to take, the case the first two tests
 * walk. `current` already runs the newest release and has one member a release back, which is where
 * "Retry crew update" is the page's one action and a run moves only the members.
 */
let lead: "behind" | "current" = "behind";
/** The legs of a crew-only run, riding the STATUS as the bridge sends them, or null for none. */
let crewLegs: UpdatePeerLeg[] | null = null;
/** When the lead stamped that run settled, or null while a leg is open. */
let crewSettledAt: number | null = null;

function runAt(state: UpdateRunState): UpdateRun {
  return {
    schema: 1,
    state,
    from: FROM,
    to: TO,
    startedAt: Date.now() - 20_000,
    updatedAt: Date.now(),
    pid: 4242,
    attempt: 0,
  };
}

/** Walk the run to its next state. The phone picks it up on its next poll of either door. */
function step(state: UpdateRunState): void {
  currentRun = runAt(state);
}

test.beforeEach(async ({ page }, testInfo) => {
  const projects = testInfo.title === NO_SHIFT_TITLE ? NO_SHIFT_PROJECTS : PHONE_PROJECTS;
  test.skip(
    !projects.has(testInfo.project.name),
    "two real bundles and a real precache; a second viewport proves nothing new here",
  );
  // Two builds, a precache over a throttled link, and a run walked through five states.
  test.setTimeout(120_000);

  clearDelay();
  clearFail();
  clearThrottle();
  serveBuild("a");
  stampedBuildId = readBuildStamp("a").id;
  currentRun = null;
  lead = "behind";
  crewLegs = null;
  crewSettledAt = null;

  await installBridge(page);
  await installReloadCounter(page);
  await disarmTheSelfUpdater(page);
});

/**
 * The bridge, for one page. Four routes, all answered from `currentRun`, so the case walks ONE record
 * rather than three that can disagree.
 *
 * A helper rather than a `beforeEach` body because the second case opens a SECOND page, and a page
 * that cannot see the run is not a second device — it is a device with no bridge.
 */
async function installBridge(page: Page): Promise<void> {
  await installApiStub(page);
  // The three routes this feature reads, all answered from `currentRun` so the case walks one record
  // rather than three that can disagree.
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { [SERVER_BUILD_HEADER]: stampedBuildId },
        body: JSON.stringify({
          ...fixtureSnapshot,
          servers: [
            {
              id: "bluefin",
              name: "bluefin",
              isLead: true,
              reachable: true,
              protocol: "ok",
            },
          ],
          update: { ...updateInfo(), run: currentRun ?? undefined },
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/update/check",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...updateInfo(),
          run: currentRun ?? undefined,
          preflight: {
            schema: 1,
            verdict: "green",
            checks: [{ id: "disk", verdict: "green", reason: "4.2 GB free" }],
          },
          // The census. On the current lead, one member a release back: the retry's reason to exist.
          crew:
            lead === "current"
              ? [{ name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: Date.now() }]
              : [],
        }),
      }),
  );
  // The standby door, on the second port in real life and on this origin here. It is the one reader
  // that still answers while the bridge restarts, which is the state this case walks through.
  await page.route(
    (url) => url.pathname === "/standby/update",
    (route) =>
      currentRun === null
        ? route.fulfill({ status: 404, contentType: "text/plain", body: "no run" })
        : route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(currentRun),
          }),
  );
  // The 202. It mints nothing and starts nothing: the case owns the run from here.
  await page.route(
    (url) => url.pathname === "/api/update",
    (route) => {
      // A peers-only start writes no record here, and the real bridge's `begin` clears the last
      // run's legs, so the status carries none until the first sweep folds the new run (M32).
      if (lead === "current") {
        crewLegs = null;
        crewSettledAt = null;
        return route.fulfill({
          status: 202,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, to: TO, major: false, run: null }),
        });
      }
      step("preflight");
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, to: TO, major: false, run: currentRun }),
      });
    },
  );
}

test.afterEach(() => {
  clearThrottle();
  clearDelay();
  clearFail();
});

function updateInfo(): UpdateInfo {
  if (lead === "current") {
    const info: UpdateInfo = {
      current: TO,
      latest: TO,
      latestUrl: null,
      releaseAvailable: false,
      majorAvailable: null,
      majorUrl: null,
      bridgeStale: false,
      checkedAt: Date.now(),
    };
    // The legs of a run this lead has no record of ride the status, with where they are going. The
    // settle stamp is absent while a leg is open, exactly as the bridge sends it.
    if (crewLegs !== null) {
      info.peers = crewLegs;
      info.peersTo = TO;
      if (crewSettledAt !== null) info.settledAt = crewSettledAt;
    }
    return info;
  }
  return {
    current: FROM,
    latest: TO,
    latestUrl: null,
    releaseAvailable: true,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: Date.now(),
  };
}

/** Count reloads from the page's own `beforeunload`, never from timing — and once per document, for
 *  the reason `service-worker.spec.ts` states: `location.reload()` can fire the event twice while
 *  committing one navigation. */
async function installReloadCounter(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    let left = false;
    window.addEventListener("beforeunload", () => {
      if (left) return;
      left = true;
      const seen = Number(window.sessionStorage.getItem(key) ?? "0");
      window.sessionStorage.setItem(key, String(seen + 1));
    });
  }, RELOADS_KEY);
}

/** Spend the self-updater's once-per-build guard for both builds, the app's own way of saying
 *  "already auto-updated for this id", so nothing auto-reloads behind this case. */
async function disarmTheSelfUpdater(page: Page): Promise<void> {
  const keys = (["a", "b"] as const).map((n) => `collie:auto-reloaded-for=${readBuildStamp(n).id}`);
  await page.addInitScript((spent: string[]) => {
    try {
      for (const key of spent) window.sessionStorage.setItem(key, "e2e");
    } catch {
      // An opaque origin has no storage. The real document has.
    }
  }, keys);
}

async function reloadCount(page: Page): Promise<number> {
  const raw = await page
    .evaluate((key: string) => window.sessionStorage.getItem(key), RELOADS_KEY)
    .catch(() => "0");
  return Number(raw ?? "0");
}

/** Is the wrapper in `App.tsx` inert right now? Asked of the DOM rather than of a class name: `inert`
 *  is the thing that closes the keyboard path, and a test for a class would not notice it going away. */
/**
 * Is the APP behind the sheet inert? Asked of `App.tsx`'s own wrapper and of nothing else.
 *
 * It used to count every `[inert]` in the document, which was only ever right by luck: `ui/one-of.tsx`
 * marks a losing strip inert and `ui/collapse.tsx` marks a closed one, so the band above the header
 * puts `[inert]` in the page whenever it is showing anything at all. That went unnoticed until the
 * collapsed update badge moved INTO that band (2026-09-20) and this helper started calling a device
 * blocked because it was displaying the very row that proves it is not.
 *
 * `#root`'s direct children are exactly the three `App.tsx` renders — the `display: contents` wrapper
 * whose `inert` is `screen.blocking`, the idle lock, and the sheet — so the child selector names the
 * one element this question is about.
 */
async function appIsInert(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelectorAll("#root > [inert]").length > 0);
}

test("update mode locks the app for a run this device started, reloads once at step 6, and ends on Done", async ({
  page,
}) => {
  await page.goto("/settings/updates");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate((key: string) => window.sessionStorage.setItem(key, "0"), RELOADS_KEY);

  // The card's button opens update mode at Ready to start, and Start update is the confirm.
  await page.getByRole("button", { name: UPDATE_ACTION }).click();
  await page.getByRole("button", { name: CONFIRM }).click();

  // THE PANEL TAKES THE SCREEN, and the app behind it is genuinely out of reach.
  const panel = page.getByRole("dialog");
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(panel.getByText(LOCK)).toBeVisible();
  expect(await appIsInert(page), "the wrapper in App.tsx is inert while the run is in flight").toBe(true);
  // No way back while the run is in flight: the app behind cannot be used.
  await expect(panel.getByRole("button", { name: BACK })).toHaveCount(0);

  // The run, walked through its states. Each one is a poll away, and the restart is the window where
  // only the standby door answers.
  for (const state of ["staging", "restarting", "verifying"] as const) step(state);
  await expect(panel.getByRole("heading", { name: "Checking the new version on bluefin" })).toBeVisible({ timeout: 15_000 });

  // THE LEAD IS DONE, AND THAT IS NOT THE END. This phone's own step comes next: the bridge serves a
  // new bundle, at a real rate, and update mode asks for it by itself.
  step("done");
  stampedBuildId = readBuildStamp("b").id;
  setThrottle({ match: readEntryScript("b"), bytesPerSecond: 8 * 1024 });
  serveBuild("b");

  // THE PREMISE, ASSERTED RATHER THAN ASSUMED: a worker really is on its way in.
  await expect
    .poll(() => workerOnItsWayIn(page), { timeout: 20_000, intervals: [200] })
    .toBe(true);

  // The file count, off the worker's own per-asset message, on this phone's row.
  const counted = /\b(\d+) of (\d+) files/;
  await expect
    .poll(async () => counted.test((await panel.textContent()) ?? ""), { timeout: 40_000, intervals: [250] })
    .toBe(true);
  expect(await appIsInert(page), "still locked while this phone downloads").toBe(true);

  // The link speeds up, the install finishes, the new worker takes control, and THAT is the reload.
  clearThrottle();
  await expect
    .poll(() => bundleOnPage(page), { timeout: 40_000, intervals: [250] })
    .toBe(readEntryScript("b"));
  expect(await reloadCount(page)).toBe(1);

  // THE NEW DOCUMENT REOPENS THE MODE, on Done: the claim outlived the page (ADR 0064). The end is a
  // screen with a way back, never a toast alone.
  const done = page.getByRole("dialog", { name: DONE });
  await expect(done).toBeVisible({ timeout: 15_000 });
  await done.getByRole("button", { name: BACK }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => appIsInert(page), { timeout: 10_000 }).toBe(false);

  // And a later load does not announce it again.
  await page.reload();
  await expect(page.getByRole("button", { name: UPDATE_ACTION })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a device that did not start the run gets a strip, never a lock", async ({ page, context }) => {
  // The second page is a second DEVICE as far as this feature is concerned: the claim lives in the
  // tab's own `sessionStorage` (`lib/update-ribbon.ts`), and a tab that never started the run has none.
  await page.goto("/settings/updates");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const other = await context.newPage();
  await installBridge(other);
  await other.goto("/");

  // The run starts on the FIRST page.
  await page.getByRole("button", { name: UPDATE_ACTION }).click();
  await page.getByRole("button", { name: CONFIRM }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
  step("staging");

  // The second page shows one line with a View, and nothing takes its screen.
  await expect(other.getByText(/Update running, started on another device/)).toBeVisible({ timeout: 20_000 });
  await expect(other.getByRole("dialog")).toHaveCount(0);
  expect(await appIsInert(other), "a device that did not start the run is never locked").toBe(false);

  // View opens the panel read-only: no lock line, and a way back.
  await other.getByRole("button", { name: en["updateScreen.strip.view"] }).click();
  const opened = other.getByRole("dialog");
  await expect(opened).toBeVisible();
  await expect(opened.getByText(LOCK)).toHaveCount(0);
  await opened.getByRole("button", { name: BACK }).click();
  await expect(other.getByRole("dialog")).toHaveCount(0);
  await other.close();
});

test("a run that moves only the members takes the screen on the device that tapped it (M32)", async ({
  page,
}) => {
  // The lead already runs the newest release; one member is a release back. The card's button names
  // it, and the run it starts writes no record on the lead.
  lead = "current";
  await page.goto("/settings/updates");

  await page.getByRole("button", { name: RETRY_CREW }).click();
  await expect(page.getByRole("dialog", { name: RETRY_CREW })).toBeVisible();
  await page.getByRole("button", { name: CONFIRM }).click();

  // THE SAME TAP TAKES THE SCREEN, before any sweep has folded the run, and the app is out of reach.
  const panel = page.getByRole("dialog");
  await expect(panel.getByText(LOCK)).toBeVisible({ timeout: 15_000 });
  expect(await appIsInert(page), "the wrapper in App.tsx is inert while the crew run is in flight").toBe(true);
  // The lead is honest about itself: already on the version, and not part of this run.
  await expect(panel.getByText(fill(en["updateScreen.row.already"], { version: TO }))).toBeVisible();

  // The first sweep folds the run: the member is moving, and the app stays locked.
  crewLegs = [{ name: "minibuch", state: "updating", version: FROM, updatedAt: Date.now() }];
  await expect(panel.getByText(en["updateScreen.state.updating"], { exact: false })).toBeVisible({ timeout: 15_000 });
  expect(await appIsInert(page)).toBe(true);

  // The member arrives and the lead stamps the run settled. The mode ends on Done, and Back hands the
  // app back.
  crewLegs = [{ name: "minibuch", state: "done", version: TO, updatedAt: Date.now() }];
  crewSettledAt = Date.now();
  const done = page.getByRole("dialog", { name: DONE });
  await expect(done).toBeVisible({ timeout: 15_000 });
  await done.getByRole("button", { name: BACK }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => appIsInert(page), { timeout: 10_000 }).toBe(false);
});

/** Is a worker on its way in right now — installing, or installed and waiting? */
async function workerOnItsWayIn(page: Page): Promise<boolean> {
  return page
    .evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.installing !== null || reg?.waiting !== null;
    })
    .catch(() => false);
}

/** Which bundle this page is RUNNING, as its entry chunk's path — the build id is part of that
 *  chunk's content, so its hash moves with it. */
async function bundleOnPage(page: Page): Promise<string> {
  return page
    .evaluate(() =>
      [...document.querySelectorAll<HTMLScriptElement>("script[src]")]
        .map((el) => new URL(el.src).pathname)
        .find((path) => path.startsWith("/assets/")),
    )
    .then((entry) => entry ?? "no entry script")
    .catch(() => "mid-navigation");
}

// ── UPDATE MODE: NOTHING IN THE PANEL MOVES (ADR 0064) ──────────────────────────────────────────
//
// Altan's rule for the build, after the drawn options shifted between "Members, one unreachable" and
// "Phone downloading": nothing in the panel moves between any two states. The mechanism is fixed
// boxes (`components/update-screen.tsx`'s header); this is the measurement. It walks one update
// through every state a real bundle can be put in, at 375x812, and after each one reads the box of
// the heading, the subtitle, every row, the note and the footer, and compares it with the first
// screen, "Ready to start", to half a pixel.
//
// It runs in Chromium (`app-phone`) AND in WebKit (`app-phone-webkit`, always in CI, `make
// e2e-webkit` on this Fedora host), because Safari is where the phone opens Collie and it disagrees
// with Chromium on geometry a unit test never sees. In an engine whose worker does not install here,
// step 6 takes the no-worker path, a plain reload, and lands on the same Done screen; the download
// state is measured when it happens.
//
// It lives in THIS file, serial with the three cases above, because all of them move the one served-
// directory pointer of the swap server, and two files doing that at once would deploy onto each other.

for (const engine of [
  { name: "Chromium, with the worker", project: "app-phone", worker: "allow" },
  { name: "WebKit, with no worker", project: "app-phone-webkit", worker: "block" },
] as const) {
  // WHY WEBKIT RUNS WITH THE WORKER BLOCKED. Playwright's WebKit does not route a request that goes
  // through a service worker, so with a worker in control every `/api/*` read here would reach the
  // swap server itself and the app would show an outage. Blocked, the phone takes its no-worker path
  // at step 6, a plain reload onto the new bundle, which is the path an HTTP install takes anyway.
  // The download state is measured in Chromium, where the worker is real.
  test.describe(`update mode's panel keeps its boxes in every state (${engine.name})`, () => {
    test.use({ viewport: { width: 375, height: 812 }, serviceWorkers: engine.worker });

    test.beforeEach(async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== engine.project, `this walk is the ${engine.name} one`);
      test.setTimeout(180_000);
      await installCrewBridge(page);
    });

    test(NO_SHIFT_TITLE, async ({ page }) => {
      await walkEveryState(page, engine.worker === "allow");
    });
  });
}

/** The walk itself: every state, measured against "Ready to start". */
async function walkEveryState(page: Page, withWorker: boolean): Promise<void> {
  const seen: string[] = [];
  const dialog = page.getByRole("dialog");
  const heading = (name: string) => page.getByRole("heading", { name, exact: true });

  await page.goto("/settings/updates");
  // A worker in control, where this walk runs with one.
  if (withWorker) await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate((key: string) => window.sessionStorage.setItem(key, "0"), RELOADS_KEY);

  // ── Ready to start. The card's button opens the mode; it does not grow the card. ──
  await page.getByRole("button", { name: fill(en["settings.updateCard.actionAll"], { version: TO }) }).click();
  await expect(heading(fill(en["updateScreen.ready.heading"], { version: TO }))).toBeVisible();
  const base = await geometry(page);
  expect(base.rows).toHaveLength(4);
  seen.push("ready");

  const measure = async (state: string) => {
    expectSame(state, await geometry(page), base);
    seen.push(state);
  };

  // ── Steps 1 to 4, the lead. ──
  await page.getByRole("button", { name: en["updateScreen.action.start"] }).click();
  await expect(heading(fill(en["updateScreen.check.heading"], { lead: "bluefin" }))).toBeVisible({ timeout: 15_000 });
  expect(await appIsInert(page), "the app is locked while the run it started is in flight").toBe(true);
  await measure("check");

  currentRun = crewRunAt("staging", WAITING());
  await expect(heading(fill(en["updateScreen.build.heading"], { version: TO, lead: "bluefin" }))).toBeVisible({ timeout: 15_000 });
  await measure("build");

  currentRun = crewRunAt("restarting", WAITING());
  await expect(heading(fill(en["updateScreen.restart.heading"], { lead: "bluefin" }))).toBeVisible({ timeout: 15_000 });
  await measure("restart");

  currentRun = crewRunAt("verifying", WAITING());
  await expect(heading(fill(en["updateScreen.verify.heading"], { lead: "bluefin" }))).toBeVisible({ timeout: 15_000 });
  await measure("verify");

  // ── Step 5, the members, and the three shapes a member row takes. ──
  currentRun = crewRunAt("done", [leg("minibuch", "updating"), leg("cellar", "waiting")]);
  await expect(heading(en["updateScreen.members.heading"])).toBeVisible({ timeout: 15_000 });
  await measure("members, one updating");

  currentRun = crewRunAt("done", [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { reason: "rate-limited, retries by 08:14" })]);
  await expect(dialog.getByText(fill(en["updateScreen.ask.limited"], { name: "cellar" }))).toBeVisible({ timeout: 15_000 });
  await measure("members, one rate-limited");

  currentRun = crewRunAt("done", [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { updatedAt: Date.now() - 90_000 })]);
  await expect(dialog.getByText(/cellar has not answered for/)).toBeVisible({ timeout: 15_000 });
  await measure("members, one unreachable");

  // ── Step 6, this phone. Skip the quiet member; the phone's turn comes. ──
  await page.getByRole("button", { name: fill(en["updateScreen.action.skip"], { name: "cellar" }) }).click();
  await expect(heading(en["updateScreen.phone.heading"])).toBeVisible();
  await measure("phone, getting the new app");

  // The bridge now serves a new bundle, slowly, and this phone asks for it on its own.
  stampedBuildId = readBuildStamp("b").id;
  setThrottle({ match: readEntryScript("b"), bytesPerSecond: 8 * 1024 });
  serveBuild("b");
  const counted = /\d+ of \d+ files/;
  const downloading = await expect
    .poll(async () => counted.test((await dialog.textContent().catch(() => "")) ?? ""), { timeout: 20_000, intervals: [100] })
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (downloading) await measure("phone downloading");
  expect(downloading || !withWorker, "with a worker, the phone's download is on screen and measured").toBe(true);

  // The install lands, the controller swaps, and the page reloads ONCE onto the new app. The new
  // document finds the claim and opens on Done.
  clearThrottle();
  await expect(heading(en["updateScreen.done.heading"])).toBeVisible({ timeout: 60_000 });
  expect(await reloadCount(page), "this phone reloaded once, at step 6").toBe(1);
  await measure("done");
  await expect(page.getByRole("button", { name: fill(en["updateScreen.action.retryOne"], { name: "cellar" }) })).toBeVisible();

  await page.getByRole("button", { name: en["updateScreen.action.back"] }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => appIsInert(page)).toBe(false);

  // ── The other two ends, each a run of its own. ──
  currentRun = crewRunAt("rolled-back", WAITING(), "run-e2e-2");
  await expect(heading(fill(en["updateScreen.rolledBack.heading"], { lead: "bluefin", from: FROM }))).toBeVisible({ timeout: 30_000 });
  await measure("rolled back");
  await page.getByRole("button", { name: en["updateScreen.action.back"] }).click();

  currentRun = crewRunAt("stuck", WAITING(), "run-e2e-3");
  await expect(heading(fill(en["updateScreen.stuck.heading"], { lead: "bluefin" }))).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("collie update --rollback")).toBeVisible();
  await measure("stuck");
  await page.getByRole("button", { name: en["updateScreen.action.back"] }).click();

  currentRun = crewRunAt("interrupted", WAITING(), "run-e2e-4");
  await expect(dialog.getByText(fill(en["updateScreen.stopped.subtitle"], { lead: "bluefin", from: FROM }))).toBeVisible({ timeout: 30_000 });
  await measure("stopped");

  test.info().annotations.push({ type: "states measured", description: seen.join(", ") });
}

function crewRunAt(state: UpdateRunState, peers: UpdatePeerLeg[], runId = "run-e2e"): UpdateRun {
  return {
    schema: 1,
    state,
    from: FROM,
    to: TO,
    startedAt: Date.now() - 20_000,
    updatedAt: Date.now(),
    pid: 4242,
    attempt: 0,
    runId,
    peers,
    reason: state === "rolled-back" || state === "stuck" || state === "interrupted" ? "the health gate timed out" : undefined,
    recovery: state === "stuck" ? "collie update --rollback" : undefined,
  };
}

const leg = (name: string, state: UpdatePeerLeg["state"], over: Partial<UpdatePeerLeg> = {}): UpdatePeerLeg => ({
  name,
  state,
  version: FROM,
  updatedAt: Date.now(),
  ...over,
});

const WAITING = (): UpdatePeerLeg[] => [leg("minibuch", "waiting"), leg("cellar", "waiting")];

const CENSUS = (): UpdateCrewMember[] => [
  { name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: Date.now() },
  { name: "cellar", version: FROM, verdict: "green", reasons: [], asOf: Date.now() },
];

function crewUpdateInfo(): UpdateInfo {
  return {
    current: FROM,
    latest: TO,
    latestUrl: null,
    releaseAvailable: true,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: Date.now(),
  };
}

async function installCrewBridge(page: Page): Promise<void> {
  await installApiStub(page);
  const servers = ["bluefin", "minibuch", "cellar"].map((name) => ({
    id: name,
    name,
    isLead: name === "bluefin",
    reachable: true,
    protocol: "ok",
  }));
  await page.route(
    (url) => url.pathname === "/api/snapshot",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { [SERVER_BUILD_HEADER]: stampedBuildId },
        body: JSON.stringify({ ...fixtureSnapshot, servers, update: { ...crewUpdateInfo(), run: currentRun ?? undefined } }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/api/update/check",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { [SERVER_BUILD_HEADER]: stampedBuildId },
        body: JSON.stringify({
          ...crewUpdateInfo(),
          run: currentRun ?? undefined,
          preflight: { schema: 1, verdict: "green", checks: [{ id: "disk", verdict: "green", reason: "4.2 GB free" }] },
          crew: CENSUS(),
        }),
      }),
  );
  await page.route(
    (url) => url.pathname === "/standby/update",
    (route) =>
      currentRun === null
        ? route.fulfill({ status: 404, contentType: "text/plain", body: "no run" })
        : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentRun) }),
  );
  await page.route(
    (url) => url.pathname === "/api/update",
    (route) => {
      currentRun = crewRunAt("preflight", WAITING());
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, to: TO, major: false, run: currentRun }),
      });
    },
  );
}

interface Box {
  readonly top: number;
  readonly height: number;
  readonly left: number;
  readonly width: number;
}

interface Geometry {
  readonly heading: Box;
  readonly subtitle: Box;
  readonly rows: readonly Box[];
  readonly note: Box;
  readonly footer: Box;
}

/** The one box a slot names, or a failure that says which slot was missing. */
function only(name: string, boxes: Box[] | undefined): Box {
  const box = boxes?.[0];
  if (box === undefined) throw new Error(`no ${name} on screen`);
  return box;
}

/** Every box the rule is about, by the panel's own `data-slot` handles (DESIGN.md §9). */
async function geometry(page: Page): Promise<Geometry> {
  const slots = ["update-heading", "update-subtitle", "update-row", "update-note", "update-footer"] as const;
  const found = await page.evaluate(
    (names) =>
      names.map((slot) =>
        [...document.querySelectorAll(`[data-slot="${slot}"]`)].map((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, height: r.height, left: r.left, width: r.width };
        }),
      ),
    [...slots],
  );
  const [heading, subtitle, rows, note, footer] = found;
  return {
    heading: only("heading", heading),
    subtitle: only("subtitle", subtitle),
    rows: rows ?? [],
    note: only("note", note),
    footer: only("footer", footer),
  };
}

/** Half a pixel, in every direction, on every box. */
function expectSame(state: string, got: Geometry, base: Geometry): void {
  const close = (what: string, a: Box, b: Box) => {
    for (const key of ["top", "height", "left", "width"] as const) {
      expect(Math.abs(a[key] - b[key]), `${state}: ${what}.${key} moved from ${b[key]} to ${a[key]}`).toBeLessThanOrEqual(0.5);
    }
  };
  close("heading", got.heading, base.heading);
  close("subtitle", got.subtitle, base.subtitle);
  expect(got.rows.length, `${state}: the row count`).toBe(base.rows.length);
  got.rows.forEach((row, i) => {
    const want = base.rows[i];
    if (want !== undefined) close(`row ${i + 1}`, row, want);
  });
  close("note", got.note, base.note);
  close("footer", got.footer, base.footer);
}

