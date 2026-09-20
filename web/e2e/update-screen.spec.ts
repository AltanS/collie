import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { SERVER_BUILD_HEADER } from "@/lib/server-build";
import { fixtureSnapshot } from "@/test/handlers";
import type { UpdateInfo, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";

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

// THE UPDATE IN PROGRESS TAKES THE SCREEN, IN A REAL BROWSER (M28/01).
//
// Two cases over the one path no unit test can reach. The reducer's own cross-product is pinned in
// `src/lib/update-screen.test.ts`, and the sheet's DOM in `src/components/update-screen.test.tsx`;
// what only a browser can show is the three things that are not functions of an input:
//
//   1. `inert` on the wrapper in `App.tsx` actually takes the app behind out of reach;
//   2. the file count on this device's own row comes off a REAL service-worker precache of a REAL new
//      bundle, one message per completed asset (`src/sw.ts`);
//   3. the page reloads ONCE, on the controller swap, and the toast that follows names the version.
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

/** The card's action button and its confirm, by their accessible names out of the app's dictionary. */
const UPDATE_ACTION = fill(en["settings.updateCard.action"], { version: "1.9.0" });
const CONFIRM = en["settings.updateCard.confirmAction"];
/** The sheet's accessible name, and the two sentences the case reads off it. */
const DIALOG = en["updateScreen.dialogAria"];
const TRUTH = en["updateScreen.truth"];
const DONE_SOLO = fill(en["updateScreen.done.solo"], { machine: "bluefin", version: "1.9.0" });
/** The crew-only case's button and its confirm (M32). */
const RETRY_CREW = en["settings.updateCard.retryCrew"];
const RETRY_CONFIRM = en["settings.updateCard.retryConfirmAction"];

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
    from: "1.8.2",
    to: "1.9.0",
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
  test.skip(
    !PHONE_PROJECTS.has(testInfo.project.name),
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
              ? [{ name: "minibuch", version: "1.8.2", verdict: "green", reasons: [], asOf: Date.now() }]
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
          body: JSON.stringify({ ok: true, to: "1.9.0", major: false, run: null }),
        });
      }
      step("preflight");
      return route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, to: "1.9.0", major: false, run: currentRun }),
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
      current: "1.9.0",
      latest: "1.9.0",
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
      info.peersTo = "1.9.0";
      if (crewSettledAt !== null) info.settledAt = crewSettledAt;
    }
    return info;
  }
  return {
    current: "1.8.2",
    latest: "1.9.0",
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

test("the sheet takes the screen for a run this device started, and the end names the version", async ({
  page,
}) => {
  await page.goto("/settings/updates");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await page.evaluate((key: string) => window.sessionStorage.setItem(key, "0"), RELOADS_KEY);

  // The confirm, exactly as an operator takes it: one tap plus one confirm.
  await page.getByRole("button", { name: UPDATE_ACTION }).click();
  await page.getByRole("button", { name: CONFIRM }).click();

  // THE SHEET TAKES THE SCREEN, and the app behind it is genuinely out of reach.
  const sheet = page.getByRole("dialog", { name: DIALOG });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  await expect(sheet).toHaveAttribute("aria-modal", "true");
  await expect(sheet.getByText(TRUTH)).toBeVisible();
  expect(await appIsInert(page), "the wrapper in App.tsx is inert while the run is in flight").toBe(true);
  // No close, because there is nothing to close to: the app behind cannot be used.
  await expect(sheet.getByRole("button", { name: en["updateScreen.close"] })).toHaveCount(0);

  // The run, walked through its states. Each one is a poll away, and the restart is the window where
  // only the standby door answers.
  for (const state of ["staging", "restarting", "verifying"] as const) {
    step(state);
    await expect(sheet.getByRole("list", { name: en["updateScreen.rows.label"] })).toBeVisible();
  }
  await expect(sheet.getByText(en["updateScreen.state.verifying"])).toBeVisible({ timeout: 15_000 });

  // THE NEW BUNDLE ARRIVES, at a real rate. The machines are done; this phone is still fetching the
  // bundle they now serve, which is the combination the reducer treats as legitimate.
  step("done");
  stampedBuildId = readBuildStamp("b").id;
  setThrottle({ match: readEntryScript("b"), bytesPerSecond: 8 * 1024 });
  serveBuild("b");
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

  // THE PREMISE, ASSERTED RATHER THAN ASSUMED: a worker really is on its way in. Without this the
  // assertion below would fail as "no file count" whatever the reason, including "nothing installed".
  await expect
    .poll(() => workerOnItsWayIn(page), { timeout: 20_000, intervals: [200] })
    .toBe(true);

  // The file count. Off the worker's own per-asset message, so a number on screen is a number of
  // assets that really landed.
  // No trailing `\b`: the elapsed clock renders immediately after the word, so the text on screen is
  // "12 of 28 files0:11" and a word boundary there never matches.
  const counted = /\b(\d+) of (\d+) files/;
  await expect
    .poll(async () => counted.test((await sheet.textContent()) ?? ""), { timeout: 40_000, intervals: [250] })
    .toBe(true);

  // The link speeds up, the install finishes, the new worker takes control, and THAT is the reload.
  clearThrottle();
  await expect
    .poll(() => bundleOnPage(page), { timeout: 40_000, intervals: [250] })
    .toBe(readEntryScript("b"));
  expect(await reloadCount(page)).toBe(1);

  // The app is back: the sheet closed itself and nothing is inert once the run is over.
  await expect(page.getByRole("dialog", { name: DIALOG })).toHaveCount(0);
  await expect.poll(() => appIsInert(page), { timeout: 10_000 }).toBe(false);

  // THE END ANNOUNCES ITSELF, and it names the MACHINE: this install has no crew. The announcement
  // goes through the app's own status channel (`lib/status.ts`), and that channel's SURFACES are the
  // dashboard's floating pill and the pane header's title slot — the Settings tree has neither, which
  // is a fact about this app and not about this feature. So the case goes where the pill is, which is
  // also where an operator who just watched an update ends up. The announcement is per document, and
  // it is windowed to ten minutes, so a fresh load moments after the run still carries it.
  await page.goto("/");
  await expect(page.getByText(DONE_SOLO)).toBeVisible({ timeout: 15_000 });
});

test("a device that did not start the run gets a badge, never a dialog", async ({ page, context }) => {
  // The second page is a second DEVICE as far as this feature is concerned: `startedHere` is a
  // document-scoped store (`lib/update-ribbon.ts`), and a tab that never posted the confirm has no
  // claim on the screen. A takeover nobody asked for reads as hijacked.
  await page.goto("/settings/updates");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const other = await context.newPage();
  await installBridge(other);
  await other.goto("/");

  // The run starts on the FIRST page.
  await page.getByRole("button", { name: UPDATE_ACTION }).click();
  await page.getByRole("button", { name: CONFIRM }).click();
  await expect(page.getByRole("dialog", { name: DIALOG })).toBeVisible({ timeout: 15_000 });
  step("staging");

  // The second page shows one line it can open, and nothing takes its screen.
  const badge = other.getByRole("button", { name: /bluefin|Update in progress/ });
  await expect(badge.first()).toBeVisible({ timeout: 20_000 });
  await expect(other.getByRole("dialog", { name: DIALOG })).toHaveCount(0);
  expect(await appIsInert(other), "a device that did not start the run is never blocked").toBe(false);

  // Tapping it expands, and the expanded sheet there IS closable — it was never a takeover.
  await badge.first().click();
  const opened = other.getByRole("dialog", { name: DIALOG });
  await expect(opened).toBeVisible();
  await expect(opened.getByRole("button", { name: en["updateScreen.close"] })).toBeVisible();
  await other.close();
});

test("a run that moves only the members takes the screen on the device that tapped it (M32)", async ({
  page,
}) => {
  // The lead already runs the newest release; one member is a release back. "Retry crew update" is
  // the one action, and the run it starts writes no record on the lead.
  lead = "current";
  await page.goto("/settings/updates");

  await page.getByRole("button", { name: RETRY_CREW }).click();
  await page.getByRole("button", { name: RETRY_CONFIRM }).click();

  // THE SAME TAP TAKES THE SCREEN, before any sweep has folded the run, and the app is out of reach.
  const sheet = page.getByRole("dialog", { name: DIALOG });
  await expect(sheet).toBeVisible({ timeout: 15_000 });
  expect(await appIsInert(page), "the wrapper in App.tsx is inert while the crew run is in flight").toBe(true);
  await expect(sheet.getByRole("button", { name: en["updateScreen.close"] })).toHaveCount(0);
  // The lead is honest about itself: already on the version, and not part of this run.
  await expect(sheet.getByText(en["updateScreen.state.current"])).toBeVisible();

  // The first sweep folds the run: the member is moving, and the app stays blocked.
  crewLegs = [{ name: "minibuch", state: "updating", version: "1.8.2", updatedAt: Date.now() }];
  await expect(sheet.getByText(en["updateScreen.state.updating"])).toBeVisible({ timeout: 15_000 });
  expect(await appIsInert(page)).toBe(true);

  // The member arrives and the lead stamps the run settled. The sheet goes, and the app is back.
  crewLegs = [{ name: "minibuch", state: "done", version: "1.9.0", updatedAt: Date.now() }];
  crewSettledAt = Date.now();
  await expect(page.getByRole("dialog", { name: DIALOG })).toHaveCount(0, { timeout: 15_000 });
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
