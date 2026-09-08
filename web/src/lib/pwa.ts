import { registerSW } from "virtual:pwa-register";

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
  try {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
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
export async function checkForUpdate(): Promise<void> {
  if (!("serviceWorker" in navigator) || !registration) {
    reloadOnce("manual");
    return;
  }
  const reg = registration;
  // Stuck-guard: if no fresh worker has activated in time, reload from the active worker so the button
  // never hangs. A plain reload (not forceReload) — a hung activation may just be a flaky network, and
  // dropping the precache offline would be worse than staying on the current build.
  setTimeout(() => reloadOnce("manual"), STUCK_GUARD_MS);
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
