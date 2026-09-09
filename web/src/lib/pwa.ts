import { registerSW } from "virtual:pwa-register";

import { BUILD, isStaleBuild } from "./build";
import { getServerBuild, subscribeServerBuild } from "./server-build";

// Service-worker registration + update wiring, in one place so the `virtual:pwa-register` import
// (a build-time virtual module) stays isolated and easy to stub in tests.
//
// The bridge serves a freshly-rebuilt bundle the instant it's built, but a browser only adopts it
// when the service worker runs an update check. We don't trust vite-plugin-pwa's own auto-reload
// (its `activated` handler wasn't firing — the manual button hung on "updating…"); instead we watch
// the worker lifecycle ourselves and reload the page the moment a new worker activates. Two entry
// points share that watcher:
//   1. a periodic update check, so a tab left open discovers and auto-applies a new build on its own;
//   2. checkForUpdate(), so the footer's "tap to update" can force the check on demand.

// How often an open tab re-checks for a newer service worker. Frequent enough to feel automatic,
// cheap enough to ignore (a conditional GET of sw.js that 304s when nothing changed).
const UPDATE_CHECK_MS = 60_000;

// Hard cap so the manual button can never get stuck on "updating…": if no worker has activated by
// now, reload anyway (served by whatever SW is active). The activated-watcher below almost always
// fires first (install+activate is usually 1–2s); this is pure insurance.
const STUCK_GUARD_MS = 8_000;

let registration: ServiceWorkerRegistration | undefined;

/**
 * Which of the two reload lanes a caller is in (M20/05).
 *
 * `auto` is every trigger this module arms for itself: the periodic check, a worker that activates on
 * its own, a controller swap. `manual` is one thing only, {@link checkForUpdate} — the band's tap and
 * the footer's, which are the operator asking.
 */
type ReloadLane = "auto" | "manual";

/**
 * ONE LATCH PER LANE, never one shared.
 *
 * A lane is in this set once it has fired. A single latch is right for the automatic lane, where
 * several triggers race to say the same thing
 * and only one reload should follow. It is wrong across the lanes. On 2026-09-07 the stuck guard had
 * already spent the one latch, and every tap the operator then made was swallowed in silence — the
 * band was not dead, it was latched. A tap must never inherit an automatic attempt's spent latch.
 */
const spent = new Set<ReloadLane>();

/**
 * A reload has been asked for and this page is on its way out.
 *
 * The guard over both lanes, and the reason the split is a split rather than a bypass: forcing a tap
 * through while an automatic reload is already navigating is a double navigation. `location.reload()`
 * does not return, so anything after this flag is set is running in a page that is already leaving.
 */
let navigating = false;

/**
 * How long a page waits for its own reload before it decides the reload is not coming.
 *
 * `location.reload()` normally does not return, and this timer never fires. When it does — a
 * standalone iOS window that refused the navigation, a cancelled unload — the page is still here
 * with its latch spent, which is 2026-09-07's swallowed tap wearing new clothes.
 */
const RELOAD_GAVE_UP_MS = 3_000;

/**
 * Say the page is leaving, and take it back if it turns out not to have left.
 *
 * Only the MANUAL lane is given back. An automatic lane that re-arms itself is a reload loop, and a
 * loop is worse than a stale bundle; the operator's tap is the way out of both.
 */
function leaving(): void {
  navigating = true;
  setTimeout(() => {
    navigating = false;
    spent.delete("manual");
  }, RELOAD_GAVE_UP_MS);
}

/**
 * THE STUCK GUARD'S RELOAD, REMEMBERED ACROSS IT.
 *
 * 2026-09-09, release lane, 1.6.0 → 1.7.0, iPhone PWA: the operator tapped "new build — tap to
 * update" over and over. Each tap showed "updating…", the page reloaded, and the same stale chip
 * came back. It took about three minutes to land on the new bundle. The bridge was consistent the
 * whole time — `X-Collie-Build` equalled the id baked into the bundle it was serving.
 *
 * What the tap did was the stuck guard's reload (below, {@link STUCK_GUARD_MS}): nothing had
 * activated in time, so the page reloaded from the ACTIVE worker, which re-served the same old
 * precache. That reload is right as insurance and wrong as an answer — it lands on the very bundle
 * the operator is trying to leave, and the next tap starts the identical cycle. Only
 * {@link forceReload}, which drops the precache before it reloads, gets out of it.
 *
 * So the guard leaves a note, and the note survives the reload it is about to cause
 * (`sessionStorage`, this tab only — a note in `localStorage` would follow the operator into a
 * second tab that never had the problem). {@link checkForUpdate} reads it once, and if the page
 * is STILL provably stale on the way in, the operator's next tap takes the unregister path instead
 * of the same cycle. Provably: the id the bridge is serving, observed off the response header
 * (`server-build.ts`), differs from the id baked into this bundle (`build.ts`) — the same fact the
 * chip itself is drawn from, so the branch cannot fire on a page that has nothing to update to. That
 * header is also how the page knows the bridge is still there ({@link bridgeAnswering}).
 */
const GUARD_RELOAD_KEY = "collie:pwa:guardReload:v1";

function rememberGuardReload(): void {
  try {
    sessionStorage.setItem(GUARD_RELOAD_KEY, "1");
  } catch {
    // No storage (private mode, a locked-down embed) just means the branch never arms. It is an
    // improvement on the guard, not a dependency of it.
  }
}

/** Read the note and spend it. Spent either way, so a page that healed is not left holding one. */
function takeGuardReload(): boolean {
  try {
    const noted = sessionStorage.getItem(GUARD_RELOAD_KEY) !== null;
    sessionStorage.removeItem(GUARD_RELOAD_KEY);
    return noted;
  } catch {
    return false;
  }
}

/**
 * Is the bridge answering right now?
 *
 * The one question that has to be asked before dropping a precache: unregistering while offline
 * strands the PWA on an error page with nothing cached. The ordinary paths get that answer from
 * `reg.update()` — it resolving means the network is up — but the path this serves cannot wait for
 * it: a wedged update job is what it is escaping, and a second `update()` queued behind a stuck one
 * does not settle until that one does.
 *
 * So the answer comes from the poll that is already running. `server-build.ts` notifies on EVERY
 * observation of the `X-Collie-Build` header, repeats included, and that header only exists on a
 * response the bridge actually sent — so a recent one is proof of a working network, on the app's own
 * mechanism, with no extra request. A fetch was tried first and thrown away: a page in this state is
 * one whose service worker is holding connections open on a stalled precache download, and the
 * browser's six-per-host limit starved the probe until it timed out. Measured on 2026-09-09.
 */
const BRIDGE_FRESH_MS = 20_000;
let lastServerBuildAt = 0;
subscribeServerBuild(() => {
  lastServerBuildAt = Date.now();
});

function bridgeAnswering(): boolean {
  return lastServerBuildAt > 0 && Date.now() - lastServerBuildAt < BRIDGE_FRESH_MS;
}

// Was a service worker already controlling this page when we loaded? On a first-ever visit it
// isn't: `immediate` registration + the SW's clientsClaim then fire ONE `controllerchange` that is
// *initial* control, not an update — reloading on it is the spurious first-load flash. We ignore
// that first event (and mark ourselves controlled from then on), so only a *subsequent*
// controllerchange — a new SW replacing the old one — reloads. On a return visit a controller
// already exists, so every change reloads.
let hadController = "serviceWorker" in navigator && Boolean(navigator.serviceWorker.controller);

function reloadOnce(lane: ReloadLane) {
  if (lane === "manual" && navigating) return;
  if (spent.has(lane)) return;
  spent.add(lane);
  leaving();
  window.location.reload();
}

// Last-resort reload that BYPASSES a wedged service worker: unregister every registration first, so
// the ensuing navigation fetches straight from the bridge instead of being answered from the stale
// precache (a plain reload stays controlled by the active worker and would re-serve the SAME old
// bundle — the "keeps saying new build, won't update" trap). The SW re-registers clean on the fresh
// load. Used ONLY when the normal worker-swap didn't confirm a newly-activated worker — never on the
// happy path, where the new precache is already in place and reloadOnce() is correct and lighter.
async function forceReload(lane: ReloadLane): Promise<void> {
  if (lane === "manual" && navigating) return;
  if (spent.has(lane)) return;
  spent.add(lane); // set before awaiting so a racing reloadOnce() can't double-fire
  // THE CACHES GO FIRST, AND NOTHING HERE WAITS ON THE WORKER (2026-09-09).
  //
  // `unregister()` is a job on the same per-scope queue as an update, so awaiting it hangs whenever
  // that queue is stuck — which is precisely the state this function exists for. Measured that day:
  // the tap reached here, the unregister never settled, and the stuck guard reloaded the page onto
  // the stale precache a second time.
  //
  // Deleting the caches needs no job and cannot be queued behind one. With its precache gone,
  // workbox's precache handler falls through to the network (`fallbackToNetwork`), so the navigation
  // below reaches the bridge whether the unregister ever lands or not. Every cache, not the precache
  // by name: the name is workbox's to change, and the only other one is the font cache
  // (`src/sw.ts` FONT_CACHE), which re-fills on first use.
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    /* no CacheStorage, or it refused — the unregister below and the reload still stand */
  }
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    // Started, deliberately not awaited: see above. It is the tidy-up, not the escape.
    void Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* ignore — reload regardless */
  }
  // Armed HERE and not beside the latch, because this lane has a real gap between the two: the
  // unregister above takes as long as it takes. `navigating` means the page is leaving, and it is
  // not leaving while an unregister is still in flight.
  leaving();
  window.location.reload();
}

function onControllerChange() {
  if (hadController) reloadOnce("auto");
  else hadController = true;
}

// Reload as soon as a freshly-installed worker reaches "activated". Used by both the periodic
// auto-check and the manual button, so neither depends on vite-plugin-pwa's (unreliable) auto-reload.
//
// `lane` is who is waiting on it. A worker found by the registration's own `updatefound` is the
// automatic lane; one this function was pointed at by `checkForUpdate` is the completion of the
// operator's tap, and reloading for it must not be able to consume the automatic latch.
function watchWorker(worker: ServiceWorker | null, lane: ReloadLane) {
  if (!worker) return;
  if (worker.state === "activated") {
    reloadOnce(lane);
    return;
  }
  worker.addEventListener("statechange", () => {
    // skipWaiting is set in the generated SW, but if a worker still parks in "installed" (waiting),
    // nudge it through so it activates instead of stranding us.
    if (worker.state === "installed") registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
    if (worker.state === "activated") reloadOnce(lane);
  });
}

registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, r) {
    registration = r;
    if (!r) return;
    // Any newly-found worker (from the poll below or a manual check) → reload when it activates.
    r.addEventListener("updatefound", () => watchWorker(r.installing, "auto"));
    // A new SW taking control is the other reliable "we're updated now" signal — but only when it
    // *replaces* a prior controller (see onControllerChange); the first-visit initial claim is not
    // an update and must not reload.
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    setInterval(() => void r.update().catch(() => {}), UPDATE_CHECK_MS);
  },
});

// Force an immediate update check — the footer's manual "tap to update". A newer SW installs,
// skip-waits, activates, and watchWorker reloads us onto it (the happy path). The ONE path that
// forceReload()s — unregistering the worker so the reload bypasses a stale precache — is when
// update() SUCCEEDS (so we're online) but finds nothing to activate while the footer shows us stale:
// the wedged-precache trap. Network-failure paths (a thrown update(), or the stuck-guard) fall back to
// a PLAIN reload instead — unregistering there would strand an offline PWA on an error page with its
// precache gone. With no SW at all (plain HTTP / insecure context) a plain reload already re-fetches.
// Since 2026-09-09 there is a SECOND way into forceReload(), at the top rather than the bottom: a tap
// that follows the stuck guard's own reload on a page that is still stale (see GUARD_RELOAD_KEY).
export async function checkForUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    reloadOnce("manual");
    return;
  }
  // Is this the tap AFTER a stuck-guard reload that landed straight back on the stale bundle
  // (2026-09-09, see GUARD_RELOAD_KEY)? Read before anything else, so the note is spent whatever this
  // tap turns into.
  const afterGuardReload = takeGuardReload();
  // THE TAP AFTER THE GUARD'S OWN RELOAD. The last tap already spent the guard on this same stale
  // bundle, so asking the worker again is those three minutes over: whatever is installing now is
  // what failed to activate last time. Unregister and go to the bridge instead — but only while the
  // bridge is answering, because dropping the precache offline is worse than a stale bundle.
  //
  // FIRST, above every other path here, because each of the others is a place this page can be stuck:
  //   * `registration` can be UNDEFINED on a perfectly healthy origin. `register()` is a job on the
  //     same per-scope queue as the wedged update, so on the page the guard just reloaded it may
  //     still be waiting behind it and `onRegisteredSW` has not run. Measured on 2026-09-09: the tap
  //     took the no-worker plain reload below and landed on the stale precache again — the same
  //     cycle, one branch further out.
  //   * `reg.update()` is on that queue too, so awaiting it waits on the wedged job as well.
  // `forceReload` needs neither of them: it asks the browser for the registrations itself.
  if (afterGuardReload && isStaleBuild(BUILD.id, getServerBuild()) && bridgeAnswering()) {
    await forceReload("manual");
    return;
  }
  if (!registration) {
    reloadOnce("manual");
    return;
  }
  const reg = registration;
  // Stuck-guard: if no fresh worker has activated in time, reload from the active worker so the
  // button never hangs. A plain reload (not forceReload) — a hung activation may just be a flaky network, and
  // dropping the precache offline would be worse than staying on the current build.
  setTimeout(() => {
    // The note for the tap after this one, left only when this timer is really the thing that
    // reloads the page — the same two conditions `reloadOnce` is about to apply. It has to be
    // written BEFORE `location.reload()`, which does not return.
    if (!navigating && !spent.has("manual")) rememberGuardReload();
    reloadOnce("manual");
  }, STUCK_GUARD_MS);
  try {
    await reg.update();
  } catch {
    // A thrown update() is a NETWORK failure (the browser fetches sw.js directly, bypassing the SW) —
    // not a wedged worker. Keep the precache and reload from it, so an offline PWA still works.
    reloadOnce("manual");
    return;
  }
  watchWorker(reg.installing, "manual");
  if (reg.waiting) {
    watchWorker(reg.waiting, "manual");
    // `ServiceWorker.postMessage(message, transfer)` — the second argument is a TRANSFER LIST, not
    // a target origin: the recipient is our own registered worker, reached by reference, so there is
    // no cross-origin window to address. Spelled out as empty because nothing is transferred; the
    // structured clone of the message itself is all that crosses.
    reg.waiting.postMessage({ type: "SKIP_WAITING" }, []);
  }
  // update() succeeded yet found nothing to activate, while the button only shows when we're provably
  // stale → the active worker is behind and won't self-update. The one place unregister-then-reload is
  // both safe (we're online) and necessary — bypass the wedged precache rather than re-serve it.
  if (!reg.installing && !reg.waiting) await forceReload("manual");
}
