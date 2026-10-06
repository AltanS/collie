// Service-worker registration and the page's half of an app update, without React.
//
// A port of the rules in web/src/lib/pwa.ts, read there for the incidents behind each one:
//
//   * The worker is registered by hand at `<mount>sw.js` with the mount as its scope (ADR 0052): the
//     mount is known only at runtime, from the document the bridge served (`<meta name=collie-base>`).
//   * THE PAGE RELOADS ONLY ON `controllerchange` (2026-09-12). A reload while a new worker is still
//     installing lands on the old precache, whose entry chunk is about to be deleted. So a tap that
//     finds a worker on its way in follows it and reloads on nothing; the swap reloads.
//   * The first `controllerchange` of a first visit is the initial claim, not an update: ignored.
//   * The swap's reload waits for the last reload hold (update/reload-hold.ts), so it cannot eat a
//     draft.
//   * A worker parked in `installed` is nudged with `SKIP_WAITING` (src/sw.ts listens for it).
//   * An open tab re-checks `sw.js` every minute.
//   * The worker posts `precache-progress` per completed file (src/sw.ts, M28/01); the sheet shows it.
//   * The one path that drops the precache (`forceReload`) runs only while the bridge is answering:
//     clearing caches offline strands an installed PWA on an error page.
//
// Not ported: update mode's hold (ADR 0064, no update mode in this build yet) and the stuck guard's
// sessionStorage note; the sheet's second tap for the same build takes the unregister path instead
// (update/self-update.ts).
import { basePath, mounted } from "@web/lib/base-path";

import { createStore } from "../lib/store";
import { isReloadHeld, reloadHeld } from "./reload-hold";

/** How often an open tab re-checks for a newer service worker (web/'s UPDATE_CHECK_MS). */
const UPDATE_CHECK_MS = 60_000;
/** A tap with nothing on its way in reloads by now anyway (web/'s STUCK_GUARD_MS). */
const STUCK_GUARD_MS = 8_000;

export type UpdateStage = "idle" | "installing";

/** `installing` while a new bundle downloads into the precache. */
export const updateStage = createStore<UpdateStage>("idle");

export interface PrecacheProgress {
  readonly done: number;
  readonly total: number;
  readonly at: number;
}

/** Files of the new bundle precached so far, or null before the first one lands. */
export const precacheProgress = createStore<PrecacheProgress | null>(null);

/** Whether a worker registration exists for this page (the e2e reads it through the DOM). */
export const registered = createStore<boolean>(false);

let registration: ServiceWorkerRegistration | undefined;
let hadController = false;
let navigating = false;
let swapWaiting = false;

function supported(): boolean {
  return "serviceWorker" in navigator;
}

function workerOnItsWayIn(reg: ServiceWorkerRegistration | undefined): ServiceWorker | null {
  return reg?.installing ?? reg?.waiting ?? null;
}

function setStage(next: UpdateStage): void {
  if (next === "idle") precacheProgress.set(null);
  updateStage.set(next);
}

// remix/component does not export its document-reload marker (runtime/document-reload.js), so the literal is copied here.
export const DOCUMENT_RELOAD_INFO = "remix-document-reload";

/**
 * A REAL document reload. `location.reload()` is not one in this shell: remix/spa listens to the
 * Navigation API and intercepts a `reload` navigation into a re-run of the router in the SAME
 * document, so the page keeps the old bundle and the old `<script>`. Found by the settings e2e on
 * 2026-10-06: the new worker had activated and served the new index.html, and the page still ran the
 * old entry chunk. A reload carrying the runtime's own marker is left to the browser.
 */
export function reloadDocument(): void {
  // A browser without the Navigation API has no listener to get past: a plain reload is a real one.
  // lib.dom types `window.navigation` as always present; a browser without the Navigation API lacks it.
  const navigation: Navigation | undefined = window.navigation;
  if (navigation === undefined) {
    window.location.reload();
    return;
  }
  navigation.reload({ info: DOCUMENT_RELOAD_INFO });
}

function reloadOnce(): void {
  if (navigating) return;
  navigating = true;
  // A reload that did not happen (a standalone iOS window that refused it) gives the tap back.
  setTimeout(() => {
    navigating = false;
  }, 3_000);
  reloadDocument();
}

/**
 * Reload past a wedged worker: drop every cache first (needs no job on the worker's queue, so it
 * cannot hang behind a stuck update), start the unregister without waiting on it, then reload. With
 * the precache gone, workbox falls through to the network and the navigation reaches the bridge.
 */
async function forceReload(): Promise<void> {
  if (navigating) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  } catch {
    // no CacheStorage, or it refused: the reload below still stands
  }
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    void Promise.all(regs.map((r) => r.unregister()));
  } catch {
    // ignore: reload regardless
  }
  reloadOnce();
}

function nudge(worker: ServiceWorker): void {
  if (worker.state !== "installed") return;
  // The second argument is a TRANSFER LIST, not a target origin: the recipient is our own worker.
  worker.postMessage({ type: "SKIP_WAITING" }, []);
}

/** Follow a worker on its way in. Returns whether there was one. Reloads for nothing it does. */
function followWorker(worker: ServiceWorker | null): boolean {
  if (!worker || worker.state === "redundant") return false;
  setStage("installing");
  nudge(worker);
  worker.addEventListener("statechange", () => {
    nudge(worker);
    if (worker.state === "activated" || worker.state === "redundant") setStage("idle");
  });
  return true;
}

function reloadWhenReleased(): void {
  if (!isReloadHeld()) {
    reloadOnce();
    return;
  }
  if (swapWaiting) return;
  swapWaiting = true;
  const stop = reloadHeld.subscribe(() => {
    if (isReloadHeld()) return;
    stop();
    swapWaiting = false;
    reloadOnce();
  });
}

function onControllerChange(): void {
  if (!hadController) {
    hadController = true;
    return;
  }
  reloadWhenReleased();
}

function onMessage(event: MessageEvent): void {
  // SAFETY: `MessageEvent.data` is a structured clone from our own registered worker, the only thing
  // that can reach this listener. Every field is read through a narrow shape and checked.
  const data = event.data as { type?: string; done?: number; total?: number } | null;
  if (data?.type !== "precache-progress") return;
  const { done, total } = data;
  if (!Number.isFinite(done) || !Number.isFinite(total)) return;
  precacheProgress.set({ done: done ?? 0, total: total ?? 0, at: Date.now() });
}

function onRegistered(reg: ServiceWorkerRegistration): void {
  registration = reg;
  registered.set(true);
  reg.addEventListener("updatefound", () => followWorker(reg.installing));
  followWorker(workerOnItsWayIn(reg));
  setInterval(() => {
    void reg.update().catch(() => undefined);
  }, UPDATE_CHECK_MS);
}

let started = false;

/** Register the worker under the mount. Once; a no-op where the browser offers no service worker. */
export function registerServiceWorker(): void {
  if (started || !supported()) return;
  started = true;
  hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("message", onMessage);
  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  void navigator.serviceWorker
    .register(mounted("/sw.js"), { scope: basePath() })
    .then(onRegistered)
    // An insecure context or a locked-down browser refuses; the app runs without a worker.
    .catch(() => undefined);
}

export interface CheckOptions {
  /** Drop the precache and reload from the bridge: this tap already reloaded once for this build. */
  bypass: boolean;
  /** The bridge answered recently, so dropping the precache cannot strand the page offline. */
  bridgeAnswering: boolean;
}

/**
 * The sheet's "Reload": get onto the bundle the bridge serves now.
 *
 * Order, as web/'s `checkForUpdate`: a worker already on its way in wins (wait for its swap); a tap
 * after a reload that came back stale takes the unregister path while the bridge answers; no worker
 * means a plain reload; otherwise ask the worker to update, follow what it finds, and drop the
 * precache only when it succeeded and found nothing (online, and the active worker is behind).
 */
export async function checkForUpdate(options: CheckOptions): Promise<void> {
  if (!supported()) {
    reloadOnce();
    return;
  }
  if (followWorker(workerOnItsWayIn(registration))) return;
  if (options.bypass && options.bridgeAnswering) {
    await forceReload();
    return;
  }
  const reg = registration;
  if (!reg) {
    reloadOnce();
    return;
  }
  setTimeout(() => {
    if (workerOnItsWayIn(reg)) return;
    reloadOnce();
  }, STUCK_GUARD_MS);
  try {
    await reg.update();
  } catch {
    // A network failure, not a wedged worker: keep the precache and reload from it.
    reloadOnce();
    return;
  }
  if (followWorker(workerOnItsWayIn(reg))) return;
  if (options.bridgeAnswering) await forceReload();
  else reloadOnce();
}
