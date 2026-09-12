import { expect, test, type Page } from "@playwright/test";

import { en } from "@/lib/i18n/messages/en";
import { SERVER_BUILD_HEADER } from "@/lib/server-build";
import { fixtureSnapshot } from "@/test/handlers";

import { installApiStub } from "./fixtures/api";
import {
  type BuildName,
  SERVER_ONLY_MARKER,
  SWAP_BASE_URL,
  clearDelay,
  clearFail,
  clearThrottle,
  readBuildStamp,
  readEntryScript,
  serveBuild,
  setDelay,
  setFail,
  setThrottle,
} from "./fixtures/builds";

// AN OLD SHELL PICKS UP A NEW BUNDLE (M26/04).
//
// Nine cases over the one path no unit test can reach: the service worker exists only in a real
// build (`vite.config.ts` sets `devOptions: { enabled: false }`), and the reload it causes is a real
// navigation. Two bundles are built into `e2e/.builds/{a,b}` and a swappable static server hands out
// one of them (`e2e/fixtures/builds.ts`, `e2e/serve-builds.ts`), so "the bridge got rebuilt" is one
// file write.
//
// WHAT REPLACES A TIMER. Staleness is not a poll of a version endpoint and not a clock: it is the
// `X-Collie-Build` response header (`src/lib/server-build.ts:17`) compared against the id baked into
// the bundle (`src/lib/build.ts:54-56`). Setting that header is the whole trigger, so nothing here
// waits on `UPDATE_CHECK_MS` (60 s) and nothing sleeps. The only clocks a case owns are its own:
// a delay on ONE asset, held by the server, and the two constants in `src/lib/pwa.ts` that the app
// itself runs on.
//
// WHY EVERY CASE HOLDS SOMETHING OPEN. A worker that handles a fetch event gets a SOFT UPDATE
// scheduled behind it, so the app's own poll makes the browser re-check `sw.js` every few seconds
// without anybody asking. Measured here on 2026-09-09: a deploy under a running page was found,
// installed, activated and reloaded within about two seconds, before a chip could be tapped. That is
// the dev-lane reproduction in the spec's Ground Truth, and it decides the shape of this file:
//   * The HEADER and the FILES are two separate steps (`announceB`, `deployB`). While `sw.js` is
//     unchanged nothing can install, so the chip's arrival is never a race.
//   * A case that needs its tap to be reachable holds ONE precached asset in the server, so the
//     install cannot finish first. Never `sw.js` itself: that fetch does not go through the page's
//     network stack at all — a `page.route` on it never fires, checked first-hand the same day.
//   * Where a tap and the browser's own check end up watching the same activation, the case claims
//     what is true — the tap was taken, and the page landed on B inside the guard — and never that
//     the tap was the only possible cause. Case seven is the exception: there the page is provably
//     moved by the tap alone, because nothing else can finish inside the window it asserts.
//
// WHAT WAS PROVEN BY HAND FIRST. 2026-09-09, release lane, Collie 1.6.0 to 1.7.0, iPhone PWA on
// `collie.ts.sprqvntrs.com`: the operator tapped the footer chip repeatedly, each tap showed
// "updating…", stopped, and came back stale. It took about three minutes. Cases five to seven are
// that incident, split into the three paths that fit it. Case three names the 2026-09-07 latch
// regression the two-lane split was built for.
//
// AND WHAT WAS PROVEN BY HAND ON 2026-09-12. Release lane, 1.8.0 to 1.8.1, a real phone: the band
// said "updated, tap to reload", the tap reloaded the page onto the OLD shell while the new worker
// was still installing, and the entry chunk that shell named was gone from disk and from the cache.
// React never booted. Cases eight and nine are that incident, and they are the two that own the
// server's throttle — a download at a real rate, not a response held back whole. The rule they pin
// is in `src/lib/pwa.ts`'s header: this page reloads only on `controllerchange`.
//
// WHAT A LOADED MACHINE DOES TO THIS FILE. Every case that asserts an activation is bounded by the
// app's own eight-second guard: past it the operator's tap reloads from the ACTIVE worker, on the
// old bundle, by design. So a runner that cannot install and activate a worker inside eight seconds
// fails these cases, and the number it misses is Collie's promise rather than this file's budget.
// Seen on 2026-09-09 at a load average of 30 on sixteen cores, with the suite green either side of
// it. If CI turns out to sit that close to the edge, the constant to move is `STUCK_GUARD_MS` in
// `src/lib/pwa.ts`, not a timeout here.
//
// ONE VIEWPORT, ONE TARGET. A service worker has no viewport, so a second run at the tablet size
// would double the slowest file in the suite and prove nothing new; and the playground registers no
// worker on purpose (`src/playground/main.tsx`), so the `states` target has nothing to offer here.

/**
 * The projects this file runs in: the phone, on the `app` target.
 *
 * `app-phone` is the name spec 02b gives the project that `playwright.config.ts` currently calls
 * `phone`. Both spellings are accepted so this file passes through that rename without an edit —
 * and a project name that matches NEITHER skips, rather than silently running the suite's slowest
 * cases at every viewport somebody adds later.
 */
const PHONE_PROJECTS = new Set(["app-phone", "phone"]);

/** `src/lib/pwa.ts:21`. A tap reloads by now even when nothing activated, so every assertion about a
 *  real activation has to land INSIDE this — otherwise the case proves the guard, not the update. */
const STUCK_GUARD_MS = 8_000;
/** `src/lib/pwa.ts:61`. How long the manual lane waits before it decides its reload never happened. */
const RELOAD_GAVE_UP_MS = 3_000;
/** The budget an activation gets in this file. Under the guard, with room for a slow runner. */
const ACTIVATION_MS = STUCK_GUARD_MS - 2_000;

/** The footer chip, by its accessible name out of the app's own dictionary. No test id was added:
 *  `src/components/build-stamp.tsx:70-77` renders a real `<button>` with this as its whole name. */
const CHIP = en["settings.buildStamp.tapToUpdate"];
/** The band (`src/components/update-ribbon.tsx`), the OTHER surface that calls `checkForUpdate()`.
 *  It is the repeat-tap surface: the footer chip disables itself for the rest of the page's life on
 *  the first tap, so a case about tapping three times has to address the band. */
const BAND = en["pwa.updateAvailable"];
/** What the same band says once a worker is on its way in (2026-09-12). The row does not go away on
 *  the tap, it changes its words: a download the operator can see is a download they wait out. */
const DOWNLOADING = en["pwa.updateInstalling"];

/** Where the reload counter lives. Read back after a navigation, so `sessionStorage`, not a variable. */
const RELOADS_KEY = "e2e:reloads";

/** The id this "bridge" is stamping on `/api/snapshot` right now. One assignment is one deploy. */
let stampedBuildId = "";

test.use({ baseURL: SWAP_BASE_URL });

// SERIAL, and not because the cases are order-dependent: they share one origin, one service-worker
// scope and one served-directory pointer. Two of them running at once would be two deploys landing
// on each other.
test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // THE PREMISE, ASSERTED BEFORE ANYTHING ELSE. Two `vite build` runs with no source edit between
  // them have to produce two different bundles, because the build id mixes version + git sha + build
  // time (`vite.config.ts:63-68`). A build system that started stamping them identically would make
  // every case below pass while proving nothing, so it fails here instead, loudly and in one line.
  const [a, b] = [readBuildStamp("a"), readBuildStamp("b")];
  expect(a.id, "build A and build B must not share a build id").not.toBe(b.id);
  expect(readEntryScript("a"), "two bundles, two entry chunks").not.toBe(readEntryScript("b"));
});

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(
    !PHONE_PROJECTS.has(testInfo.project.name),
    "the service worker has no viewport, and the playground registers no worker",
  );
  // Two real builds, several installs and a stuck guard at 8 s each: this file is the slow one.
  test.setTimeout(120_000);

  clearDelay();
  clearFail();
  clearThrottle();
  serveBuild("a");
  stampAs("a");

  await installApiStub(page);
  // The staleness trigger, and the only one: one response header on the snapshot poll, exactly as
  // the bridge stamps it (`bridge/server.ts` BUILD_HEADER, read in `src/lib/api.ts:272`).
  await page.route(/\/api\/snapshot/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { [SERVER_BUILD_HEADER]: stampedBuildId },
      body: JSON.stringify(fixtureSnapshot),
    }),
  );
  await installReloadCounter(page);
  await disarmTheSelfUpdater(page);
});

test.afterEach(() => {
  clearDelay();
  clearFail();
  clearThrottle();
});

/** Stamp this build's id on every following snapshot response. The deploy, from the app's side. */
function stampAs(name: BuildName): void {
  stampedBuildId = readBuildStamp(name).id;
}

/**
 * Count reloads, from the page's own `beforeunload`, never from timing.
 *
 * Three of the cases below are about HOW MANY times the page left — one plain reload, exactly one
 * reload for three taps — and a wall-clock read of that is a guess. The counter is written by the
 * page that is leaving and read by the page that arrives, which is what `sessionStorage` is for.
 * It also records the flag this file reads to know the shell came out of the precache.
 *
 * ONE DOCUMENT COUNTS ONCE, and the `left` latch is why. An activation calls `location.reload()`
 * twice in two different tasks — `watchWorker` at `"activated"`, then the automatic lane again on the
 * `controllerchange` behind it (`src/sw.ts:90` claims the page) — and Chromium fires `beforeunload`
 * for each of those calls while committing only one navigation. Measured here on 2026-09-09. Without
 * the latch every activation would read as two reloads, which is a fact about `location.reload()` and
 * not about this app's update flow.
 */
async function installReloadCounter(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    // Whether THIS document was controlled when it loaded, written before any app code runs and
    // overwritten by every later document, so a read is always about the page on screen. In storage
    // rather than on `window` because the reader is a `waitForFunction` in another process.
    window.sessionStorage.setItem(
      "e2e:controlledAtLoad",
      String(Boolean(navigator.serviceWorker?.controller)),
    );
    let left = false;
    window.addEventListener("beforeunload", () => {
      if (left) return;
      left = true;
      const seen = Number(window.sessionStorage.getItem(key) ?? "0");
      window.sessionStorage.setItem(key, String(seen + 1));
    });
  }, RELOADS_KEY);
}

/**
 * Take the API-observed self-updater out of the picture, on purpose and by its own rules.
 *
 * `src/lib/self-update.ts` is a THIRD trigger: two consecutive stale sightings of the same id and it
 * calls `checkForUpdate()` itself, without a tap. Left armed it would race every tap in this file and
 * a passing case would not say which trigger did the work. Its once-per-build guard is a
 * `sessionStorage` key (`self-update.ts:61`), so pre-spending that key for both builds is the app's
 * own way of saying "already auto-updated for this id": the controller shows the band instead of
 * reloading, and the band is a surface a case can tap. Nothing is stubbed and no app code changes.
 *
 * The path it would otherwise take has its own coverage in `src/lib/self-update.test.ts`.
 */
async function disarmTheSelfUpdater(page: Page): Promise<void> {
  const keys = (["a", "b"] as const).map((n) => `collie:auto-reloaded-for=${readBuildStamp(n).id}`);
  await page.addInitScript((spent: string[]) => {
    try {
      for (const key of spent) window.sessionStorage.setItem(key, "e2e");
    } catch {
      // An opaque origin (about:blank) has no storage. The real document has.
    }
  }, keys);
}

/** How many times this page has left, since the last {@link resetReloadCount}. */
async function reloadCount(page: Page): Promise<number> {
  const raw = await page
    .evaluate((key: string) => window.sessionStorage.getItem(key), RELOADS_KEY)
    .catch(() => "0"); // a navigation mid-read is not an answer; the poll asks again
  return Number(raw ?? "0");
}

async function resetReloadCount(page: Page): Promise<void> {
  await page.evaluate((key: string) => window.sessionStorage.setItem(key, "0"), RELOADS_KEY);
}

/**
 * Which bundle this page is RUNNING, as its entry chunk's path.
 *
 * The baked build id is not reachable from the page: vite `define` inlines `__BUILD_INFO__` into
 * module scope and nothing puts it on `window`. The entry chunk's hashed name is the next best thing
 * and it is not a proxy — the build id is part of that chunk's content, so its hash moves with it,
 * and `e2e/fixtures/builds.ts` reads the same name out of each build's `index.html`. The footer's own
 * label cannot do this job: it prints the stamp to the minute, and two builds share a minute.
 */
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

/** Wait until the page is running this build, inside `budget`. The one assertion every case makes. */
async function expectRunning(page: Page, name: BuildName, budget = ACTIVATION_MS): Promise<void> {
  await expect
    .poll(() => bundleOnPage(page), { timeout: budget, intervals: [100] })
    .toBe(readEntryScript(name));
}

/** The registration count, i.e. whether anything unregistered or registered a second worker. */
async function registrationCount(page: Page): Promise<number> {
  return page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
}

/**
 * Open the app on build A and prove the worker took control of it.
 *
 * The second load is the point, not a retry: a case whose premise is "a browser holding the
 * PRECACHED shell" is only true once a navigation has been ANSWERED by the worker, and the first
 * load never is — the worker installs during it. `__collieControlledAtLoad` is recorded by an init
 * script before any app code runs, so it says the document was controlled at load time, not merely
 * that a controller turned up afterwards. A case that ran with no controller would be a false pass.
 */
async function openAndTakeControl(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  // A controlled-at-load document is WAITED FOR, not forced. The bundle's own registration reloads
  // the page once when the first worker claims it, so one usually arrives on its own; racing it with
  // a `page.reload()` of ours is how this helper detached itself from a navigating page. The fallback
  // is a fresh navigation, in case that behaviour ever goes away.
  const controlledAtLoad = (timeout: number) =>
    page.waitForFunction(() => window.sessionStorage.getItem("e2e:controlledAtLoad") === "true", undefined, {
      timeout,
    });
  try {
    await controlledAtLoad(10_000);
  } catch {
    await page.goto("/");
    await controlledAtLoad(10_000);
  }

  await expect(page.getByRole("main")).toBeVisible();
  await expectRunning(page, "a");
  await settle(page);
  await resetReloadCount(page);
}

/**
 * Wait until the page has stopped moving of its own accord, then let the caller zero the counter.
 *
 * The first visit to an origin costs MORE THAN ONE navigation, and how many is not a number to hard-
 * code: the worker installs during the first load and claims the page, the bundle's own registration
 * reloads for that, and a second hop was measured on 2026-09-09 as well. A case that zeroed the
 * counter while one of those was still on its way read the app's own startup as its first reload,
 * which is the only flake this file has ever had (a 1-in-15 failure of "nothing has reloaded yet").
 *
 * This is a wait on a CONDITION, not a sleep: two consecutive reads with the same count mean nothing
 * is in flight. Under `RELOAD_GAVE_UP_MS`, so it cannot outlast the app's own patience either.
 */
async function settle(page: Page): Promise<void> {
  let previous = -1;
  for (let read = 0; read < 12; read += 1) {
    const now = await reloadCount(page);
    if (now === previous) return;
    previous = now;
    await new Promise((done) => setTimeout(done, 250));
  }
}

/**
 * ANNOUNCE build B: the bridge's header starts naming it, and the files stay A's for now.
 *
 * This is the staleness trigger on its own — one response header (`src/lib/server-build.ts:17`)
 * against the id baked into the bundle (`src/lib/build.ts:11`) — and it is a step of its own because
 * the chip and the band are drawn from that comparison, while `sw.js` is what a browser installs
 * from. Announcing first puts the offer on screen before anything can install.
 */
function announceB(): void {
  stampAs("b");
}

/** DEPLOY build B: the served directory swaps. From here a browser can find the new worker. */
function deployB(): void {
  serveBuild("b");
}

/**
 * THE UPDATE JOB ITSELF, WEDGED — which is what "stuck" means since 2026-09-12.
 *
 * Case seven used to wedge the INSTALL — it held `/index.html`, the one precached entry that moves
 * between builds and that the running page never asks for by that path — and let the app's
 * eight-second guard reload over it. That is now the bug rather than the behaviour: while a worker
 * is installing the page waits, however long the download takes. So the case reproduces the state
 * the guard is still for — an update job that never settles, so `reg.update()` never resolves and
 * nothing is ever on its way in.
 *
 * Held in the SERVER, not with `page.route`: the worker script is fetched through the
 * service-worker machinery and a route on it never fires (checked first-hand on 2026-09-09). The
 * server has no such blind spot, which is what case five's 503 already relies on.
 */
function holdTheWorkerScript(ms: number): void {
  setDelay({ match: "/sw.js", ms });
}

/**
 * Let the wall clock cross one of the app's own constants.
 *
 * The ONLY wait in this file that is not a wait on a condition, and it is not a wait for something to
 * happen: case six has to place a tap on the far side of {@link RELOAD_GAVE_UP_MS}, and that boundary
 * is a number in `src/lib/pwa.ts`, not an observable event. Spelled as a promise in the test process
 * rather than with the runner's page-side wait helper, so nothing in the browser is idled and the
 * intent is legible. Nothing else in this file waits on a clock at all.
 */
function crossTheGiveBackBoundary(): Promise<void> {
  return new Promise((done) => setTimeout(done, RELOAD_GAVE_UP_MS + 300));
}

/**
 * A SLOW LINK, not a wedge (2026-09-12).
 *
 * The incident's install was not stuck: build B's entry chunk was 869 kB coming down a phone's link
 * with the tab in the background, and it took 125 seconds. Nothing about that is a failure, so
 * a held response ({@link setDelay}) is the wrong instrument — it says "this asset will never
 * arrive", and the two cases below are about an asset that is arriving, slowly. The rate is the
 * server's (`e2e/serve-builds.ts`), one chunk every 100 ms, and the case takes it away the moment
 * its assertions are in.
 */
const SLOW_LINK_BPS = 8 * 1024;

function throttleTheInstall(bytesPerSecond = SLOW_LINK_BPS): void {
  // Build B's ENTRY CHUNK, one file, for the reason case six gives: a match on `/assets/` slows ten
  // of them and a browser runs six requests to a host at once.
  setThrottle({ match: readEntryScript("b"), bytesPerSecond });
}

/** Is a worker on its way in right now — installing, or installed and waiting? */
async function workerOnItsWayIn(page: Page): Promise<boolean> {
  return page
    .evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      return reg?.installing !== null || reg?.waiting !== null;
    })
    .catch(() => false); // a navigation mid-read is not an answer
}

/**
 * Every path the PAGE asked for, from the moment this is called.
 *
 * The incident is a request, not a state: the reloaded page asked for build A's entry chunk, which
 * was gone from disk and gone from the cache the new worker had just cleaned, and the module never
 * loaded. So the case watches what the page asks for and what it gets back, and the two facts it
 * asserts are exactly the two the operator suffered — an OLD entry chunk requested at all, and an
 * entry script that came back 404.
 */
function watchTheWire(page: Page) {
  const asked: string[] = [];
  const missing: string[] = [];
  page.on("request", (request) => asked.push(new URL(request.url()).pathname));
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && path.startsWith("/assets/") && path.endsWith(".js")) {
      missing.push(`${path} → 404`);
    }
  });
  return { asked, missing };
}

/** React is on screen, and the pre-React splash in `web/index.html` is not. The operator's whole
 *  test of "did it come back": a dog that never stops galloping is the bug. */
async function expectReactBooted(page: Page): Promise<void> {
  await expect(page.getByRole("main")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel("Loading Collie")).toHaveCount(0);
}

// ── The seven cases ─────────────────────────────────────────────────────────────────────────────

test("the footer chip carries a page from build A to build B", async ({ page }) => {
  // Proven by hand on 2026-09-09 on the release lane, and again on the dev lane the same day.
  await openAndTakeControl(page);
  // Level with the bridge, so there is nothing to tap: the chip is drawn from the comparison, not
  // from a flag somebody could leave on.
  await expect(page.getByRole("button", { name: CHIP })).toHaveCount(0);

  announceB();

  // The chip appears on the first snapshot poll that carries B's id — the whole trigger.
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });
  // And the page is still running A. Without this the case could pass on a browser that had already
  // healed itself, which is the false pass this file is most exposed to.
  expect(await bundleOnPage(page)).toBe(readEntryScript("a"));

  // The files land, and the tap follows immediately — nothing else has had a fetch event in between
  // to find them with.
  deployB();
  await page.getByRole("button", { name: CHIP }).click();

  await expectRunning(page, "b");
  expect(await reloadCount(page)).toBe(1);
  // Level again, from the page's own point of view: the chip is gone because the comparison is even.
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("button", { name: CHIP })).toHaveCount(0);
});

test("the automatic lane picks up build B with no tap", async ({ page }) => {
  await openAndTakeControl(page);
  announceB();
  deployB();

  // `registration.update()` is exactly what the 60 s interval calls (`src/lib/pwa.ts:152`), so this
  // drives the automatic lane's real path without waiting for it. The reload comes from the module's
  // own `updatefound` → `watchWorker(…, "auto")` chain; nothing here touches the UI.
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.update();
  });

  await expectRunning(page, "b");
  expect(await reloadCount(page)).toBe(1);
});

test("a tap after an incomplete automatic attempt still reloads (the 2026-09-07 latch)", async ({
  page,
}) => {
  // 2026-09-07: ONE shared latch served the automatic triggers and the operator's tap alike, so
  // whichever fired first silenced the other for the life of the page. `src/lib/pwa.ts:32-43` is the
  // split that fixed it, and this is the sequence it was built for — an automatic attempt in flight,
  // then a tap.
  //
  // WHAT A BROWSER CAN AND CANNOT PIN HERE. A spent latch is only observable inside one page's life,
  // and every reload in Chromium navigates, which ends that life and clears the latches. The
  // counterfactual — a reload that does not navigate, i.e. 2026-09-07's standalone iOS window — is
  // not reproducible here, so it stays in `src/lib/pwa.test.ts` where a latch can be spent without a
  // navigation. What this case pins is the half that only a browser can: after an automatic attempt
  // has come and gone with nothing to show, the tap is still live and it is the page's route to B.
  //
  // THE ATTEMPT FAILS RATHER THAN HANGS, and that is what makes this case timing-free. A hanging
  // install has to be held open across three round trips to the browser and then released inside the
  // eight-second guard, and on a loaded machine those two windows overlap: at a load average of 26
  // it failed both ways, once because the install finished before the tap and once because the
  // release was too late (2026-09-09). A 503 on the worker script is the same event for this
  // module — an automatic check that produced nothing — with no clock in it at all.
  await openAndTakeControl(page);
  announceB();
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });

  // The worker script's wire, down for every request, so the browser's own check cannot install
  // anything behind this case either.
  setFail({ match: "/sw.js", status: 503, times: 50 });
  deployB();

  // The automatic lane's own check — the call the sixty-second interval makes (`src/lib/pwa.ts:152`),
  // where a rejection is swallowed on purpose. It did not complete, and nothing reloaded for it.
  const attempt = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    try {
      await registration?.update();
      return "resolved";
    } catch {
      return "threw";
    }
  });
  expect(attempt, "the automatic attempt must not have completed").toBe("threw");
  expect(await reloadCount(page)).toBe(0);

  // The wire is back, and the operator taps. Under one shared latch this tap was the one that went
  // nowhere.
  clearFail();
  await page.getByRole("button", { name: CHIP }).click();

  // The tap was TAKEN, not swallowed, and these two lines are the proof: ONE reload, onto build B,
  // on a page where nothing else could have caused it — the automatic lane had already thrown, and
  // `sw.js` was refused until this tap. The chip's own "updating…" state is deliberately NOT asserted
  // here: the install that follows this tap is not held back by anything, so the state can be gone
  // again before an assertion can see it (twice at a load average of 3, 2026-09-09).
  await expectRunning(page, "b");
  expect(await reloadCount(page)).toBe(1);
});

test("a denylisted navigation with a query string reaches the server, not the precache", async ({
  page,
}) => {
  await openAndTakeControl(page);

  // `/auth?rd=…` is the shape Authelia and oauth2-proxy both bounce to, and it is why the denylist
  // is written `[/?]` rather than `/`: workbox matches `pathname + search`, not the pathname alone
  // (`src/lib/sw-routes.ts:33-38`). A rule anchored on a trailing slash would miss this URL and the
  // installed PWA would get the cached app shell instead of the proxy's sign-in page.
  await page.goto("/auth?rd=%2Fpane%2Fw1");

  // The server answered, and it answered THIS url: the query string came along.
  await expect(page.getByText(SERVER_ONLY_MARKER).first()).toBeVisible();
  await expect(page.getByText("/auth?rd=%2Fpane%2Fw1")).toBeVisible();
  // Not the precached shell. The app's own header button is mounted on every route it renders.
  await expect(page.getByRole("button", { name: en["nav.home.aria.default"] })).toHaveCount(0);
  // And a worker WAS in charge of this navigation, so the denylist is what let it through rather
  // than an origin that happened to have no worker.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
});

test("a thrown update() reloads plainly, keeps the precache, and the next tap lands on B", async ({
  page,
}) => {
  // 2026-09-09, path (a): `reg.update()` threw — a network failure, since the browser fetches sw.js
  // itself — so `checkForUpdate` took the plain-reload branch (`src/lib/pwa.ts:178`) that KEEPS the
  // precache. The page came back on the same bundle with the same chip.
  //
  // The failure is served, not routed: a `page.route` on `**/sw.js` never fires, because the worker
  // script is fetched through the service-worker machinery and not through the page (checked
  // first-hand on 2026-09-09 — zero route hits, and `update()` resolved). One 503 from the server is
  // the honest version of the same event.
  await openAndTakeControl(page);
  announceB();
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });

  // The worker script's wire, down. Every request, not one: with `sw.js` 503ing, the browser's own
  // soft update cannot install anything either, so the page's whole first phase is the tap's.
  setFail({ match: "/sw.js", status: 503, times: 50 });
  await page.getByRole("button", { name: CHIP }).click();

  // ONE plain reload, from the counter, and it landed back on A.
  await expect.poll(() => reloadCount(page), { timeout: ACTIVATION_MS }).toBe(1);
  await expectRunning(page, "a");
  // The precache was KEPT: nothing unregistered, and this shell came out of a worker. That is the
  // branch's whole point — unregistering on a network failure strands an offline PWA.
  expect(await registrationCount(page)).toBe(1);
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  // And the chip is back, saying the same thing it said before the tap. Three minutes of that is
  // what the operator reported.
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });

  // The wire is up again and the files land. The next tap gets there, inside the guard.
  clearFail();
  deployB();
  await page.getByRole("button", { name: CHIP }).click();
  await expectRunning(page, "b", STUCK_GUARD_MS - 1_000);
  // Not pinned to two: with `sw.js` answering again, this page's own registration is also allowed to
  // find B, and a count here would be asserting which of two honest paths won a race.
  expect(await reloadCount(page)).toBeGreaterThanOrEqual(2);
});

test("three taps on an installing worker produce exactly one reload and no second worker", async ({
  page,
}) => {
  // 2026-09-09, path (b): a worker was still installing from an earlier tap, so each further tap only
  // attached another watcher. What must NOT happen is a reload per tap, or a second registration.
  // Since 2026-09-12 a tap that finds a worker on its way in does even less than that — it follows it
  // and reloads for nothing — and the band says "downloading" rather than repeating the offer.
  await openAndTakeControl(page);
  announceB();

  // The band, not the footer chip: the chip disables itself on the first tap
  // (`src/components/build-stamp.tsx:46`), so it cannot be tapped three times. The band calls the
  // same `checkForUpdate()` and stays live, and it is what the operator was hammering on the phone.
  // It needs two consecutive stale polls to appear (`src/lib/self-update.ts`), which is why the
  // files are still A's here: nothing can install while the offer is arriving.
  const band = page.getByRole("button", { name: BAND });
  await expect(band).toBeVisible({ timeout: 30_000 });

  // The precache download, throttled so the worker is still installing while all three taps go in,
  // and released once they are. Build B's ENTRY CHUNK, one file — a match on `/assets/` holds ten of
  // them and a browser only runs six requests to a host at once, so the install would take two rounds
  // of the hold instead of one.
  setDelay({ match: readEntryScript("b"), ms: 15_000 });
  deployB();

  await band.click(); // tap one — the install starts and is held

  // THE ROW CHANGES ITS WORDS ON THE FIRST TAP (2026-09-12). It does not go away: taps two and three
  // land on the same band, now saying a download is in progress, which is what the operator hammering
  // the phone never had. The row is no longer a button — a download has nothing for a tap to do, and
  // it carries a close instead so a wait on a dead link is escapable — so the taps land on the text
  // itself, exactly as a thumb on the phone does.
  const downloading = page.getByText(DOWNLOADING);
  await expect(downloading).toBeVisible({ timeout: 15_000 });

  await downloading.click(); // tap two, well inside RELOAD_GAVE_UP_MS
  await crossTheGiveBackBoundary();
  await downloading.click(); // tap three, on the far side of it
  // All three taps are in, so the hold has nothing left to do. Released here rather than at the end
  // of the case, so the activation races nothing but the machine.
  clearDelay();

  await expectRunning(page, "b", STUCK_GUARD_MS - 1_000);
  // The three taps are ONE reload, from the counter and not from timing.
  expect(await reloadCount(page)).toBe(1);
  // And nothing registered a second worker on the way: still one registration, still controlled.
  expect(await registrationCount(page)).toBe(1);
});

test("the stuck guard reloads onto A, and the tap after it unregisters instead of repeating", async ({
  page,
}) => {
  // 2026-09-09, the shape that cost three minutes. An install that cannot finish inside
  // STUCK_GUARD_MS leaves the guard to reload the page — served by the ACTIVE worker, so it lands on
  // the bundle the operator is trying to leave, and the next tap starts the identical cycle.
  //
  // This case is what pins the fix: the guard now leaves a note that survives its own reload, and a
  // tap on a page that is STILL provably stale takes the unregister-and-reload path
  // (`forceReload("manual")`) instead of waiting on another worker. The unit test for the branch is
  // in `src/lib/pwa.test.ts`; what only a browser can show is that the second tap actually arrives
  // on build B.
  await openAndTakeControl(page);
  announceB();
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });

  // THE WORKER SCRIPT, held well past the guard (changed 2026-09-12, see {@link holdTheWorkerScript}).
  // `reg.update()` never settles, so nothing is ever on its way in, no install can finish inside this
  // case at all — not the tap's, and not the browser's own — and whatever moves this page to B is not
  // an activation. Holding one PRECACHED asset no longer produces this state: a worker that is
  // installing is a download, and the page now waits it out instead of reloading over it.
  holdTheWorkerScript(20_000);
  deployB();
  await page.getByRole("button", { name: CHIP }).click();

  // The guard's own reload, at 8 s, on the stale bundle. Counted, not timed.
  await expect.poll(() => reloadCount(page), { timeout: STUCK_GUARD_MS + 6_000 }).toBe(1);
  await expectRunning(page, "a");
  // And the chip is back, which is the operator's whole experience of that reload.
  await expect(page.getByRole("button", { name: CHIP })).toBeVisible({ timeout: 20_000 });

  // THE HOLD STAYS ON, and this is a deliberate departure from the spec's wording ("release the
  // delay, then tap"). Releasing it lets the held install finish, and then an activation could be
  // what carries the page to B — which is the one thing this case must be able to rule out. Held, for
  // the next twelve seconds nothing can activate at all, so the tap taking the unregister path is the
  // only thing that can move this page, and the assertion below says so with a five-second budget.
  await page.getByRole("button", { name: CHIP }).click();
  // Build B, well inside the guard, because this navigation was not answered by the wedged precache.
  // The budget is deliberately shorter than the held asset: no activation could have done this, so
  // the unregister-and-reload path is the only thing that can have.
  await expectRunning(page, "b", 5_000);
  // Two reloads at least — the guard's and this one. Not pinned to two exactly: a page that reloads
  // with its worker unregistered arrives UNCONTROLLED, and the bundle's own registration reloads it
  // once more when the fresh worker claims it. That third hop is the cost of the escape hatch, and
  // the operator sees it as one update rather than two.
  await expect.poll(() => reloadCount(page), { timeout: 5_000 }).toBeGreaterThanOrEqual(2);
});


// ── The 2026-09-12 race: a tap while the new worker is still installing ──────────────────────────

test("a tap while build B is still installing never reloads onto build A", async ({ page }) => {
  // 2026-09-12, release lane, 1.8.0 to 1.8.1, real phone. The band said "updated, tap to reload".
  // The tap reloaded the page at the eight-second stuck guard while build B's worker was still
  // installing — 125 seconds of it, an 869 kB chunk on a slow link with the tab backgrounded. The
  // reload was answered by the OLD worker, so the page got build A's index.html, which asked for
  // build A's entry chunk; by the time that request went out the new worker had activated and swept
  // the old precache, and the chunk was gone from disk too. React never booted and the pre-React dog
  // galloped forever. A second manual reload fixed it.
  //
  // THE RULE THIS PINS: while a worker is installing there is no "stuck", there is "downloading",
  // and the page does not reload until the new worker is in control.
  await openAndTakeControl(page);
  announceB();
  const band = page.getByRole("button", { name: BAND });
  await expect(band).toBeVisible({ timeout: 30_000 });

  const wire = watchTheWire(page);
  throttleTheInstall();
  deployB();

  await band.click();
  // The premise, asserted rather than assumed: this tap landed on a worker that is on its way in.
  await expect
    .poll(() => workerOnItsWayIn(page), { timeout: 10_000, intervals: [100] })
    .toBe(true);

  // Past the app's own stuck guard, which is where the incident happened. The one wall-clock wait
  // this case owns, and it is a boundary in `src/lib/pwa.ts` rather than an event to wait for.
  await new Promise((done) => setTimeout(done, STUCK_GUARD_MS + 2_500));

  // NOTHING LEFT. The page has not reloaded, so it cannot have reloaded onto the old shell.
  // SOFT, both of them, because they are two readings of ONE fact and a reader of a failure wants
  // both: the page left, and what the page that arrived then went looking for.
  expect.soft(await reloadCount(page), "no reload while a worker is installing").toBe(0);
  expect
    .soft(
      wire.asked.filter((path) => path === readEntryScript("a")),
      "build A's entry chunk must never be asked for again after the swap",
    )
    .toEqual([]);

  // The link speeds up, the install finishes, the new worker takes control, and THAT is the reload.
  clearThrottle();
  await expectRunning(page, "b", 20_000);
  await expectReactBooted(page);
  expect(wire.missing, "no entry script came back 404").toEqual([]);
  expect(await reloadCount(page)).toBe(1);
});

test("a manual reload during the install still comes back to a booted app", async ({ page }) => {
  // The operator's own way out on the day: reload again. It must not be the way INTO the hang —
  // a navigation the old worker answers from its own precache is fine, as long as the chunk that
  // shell names is still there to serve. What must not happen is an entry script that 404s and a
  // page that never boots.
  await openAndTakeControl(page);
  announceB();
  const band = page.getByRole("button", { name: BAND });
  await expect(band).toBeVisible({ timeout: 30_000 });

  const wire = watchTheWire(page);
  throttleTheInstall();
  deployB();

  await band.click();
  await expect
    .poll(() => workerOnItsWayIn(page), { timeout: 10_000, intervals: [100] })
    .toBe(true);

  // One more reload, by hand, well inside the install window.
  await page.reload();
  await expectReactBooted(page);
  expect(wire.missing, "no entry script came back 404").toEqual([]);

  // And the update still lands once the link speeds up.
  clearThrottle();
  await expectRunning(page, "b", 20_000);
  await expectReactBooted(page);
  expect(wire.missing, "no entry script came back 404").toEqual([]);
});
