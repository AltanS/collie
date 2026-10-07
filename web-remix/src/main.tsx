// Boot. Starts the polling beat and the idle lock, then the runtime over the module-scope router.
// The runtime renders into the document's top frame (<body>); the router outlives it.
//
// TWO DOCUMENTS, ONE BOOT (S1, `experiments/remix-v3/ACTION-PLAN.md` B):
//   - A SERVER DOCUMENT (the bridge rendered `/` or `/pane/:paneId`) holds one `AppRoot` island and
//     its props in `rmx-data`. The stores are primed from those props first, so the hydrating tree
//     reads what the server rendered from, then `run()` hydrates the island in place: no node is
//     replaced and no splash is drawn. The first routed tap replaces the body once (lib/app-runtime.ts).
//   - THE STATIC SHELL (offline, the service worker's fallback, a request that may not read the
//     snapshot, every other route) holds the splash. The runtime replaces it with `BootSplash` and
//     resolves the route, exactly as remix/spa's `run(router, { fallback })` did.
//
// The per-device prefs (lib/prefs.ts) load synchronously when that module evaluates, which is
// before `run()` below, so the first render paints the stored choices and never the defaults.
import "./app.css";

import type { AppRuntime } from "remix/component";

import { basePath } from "@web/lib/base-path";

import { APP_ROOT_ENTRY, AppRoot, type AppRootProps } from "./app-root";
import { startAppRuntime } from "./lib/app-runtime";
import { address, paneStore } from "./lib/data";
import { documentSeed } from "./lib/identity-seed";
import { PANE_LINES, findPane } from "./routes/pane/data";
import { primePaneFrames, paneFrameSrc } from "./routes/pane/pane-frames";
import { parseAgent } from "./routes/pane/parse";
import { matchAppRoute } from "./app-root";
import { paneScopeKey } from "@web/lib/scope";
import { startIdleLock } from "./lib/idle";
import { quietCurrentEntry } from "./lib/navigate";
import { installPolyfills } from "./lib/polyfills";
import { applyFramesParam, displayPrefs, paneFrames, startPrefCookie, startPrefSync } from "./lib/prefs";
import { startPolling } from "./lib/polling";
import { clearReconcileReloadFlag, reloadOnReconcileError, tabStorage } from "./lib/reconcile-reload";
import { mountedRouter } from "./router";
import { startUpdates } from "./update/boot";
import { reloadDocument } from "./update/pwa";
import { BootSplash } from "./shell";
import { startNavTracking } from "./shell/screen-transition";

installPolyfills();

/** The longest `afterFirstPaint` waits. */
const FIRST_PAINT_WAIT_MS = 100;

/** The island registry. A document holds one island, `AppRoot`; any other id is not ours. */
function loadModule(moduleUrl: string, exportName: string): typeof AppRoot {
  if (`${moduleUrl}#${exportName}` !== APP_ROOT_ENTRY) throw new Error(`Collie: no island ${moduleUrl}#${exportName}`);
  return AppRoot;
}

/**
 * The `AppRoot` props a server document carries, or null for the static shell. Read straight out of
 * `rmx-data` before the runtime starts, so the stores can be primed first.
 */
function serverProps(): AppRootProps | null {
  const script = document.getElementById("rmx-data");
  if (script === null) return null;
  try {
    // SAFETY: `rmx-data` is the runtime's own JSON, written by the bridge's render of `AppRoot`
    // (ssr/render.tsx): `h` maps island ids to `{ moduleUrl, exportName, props }`. A document from
    // anywhere else fails the entry check below and boots as the static shell.
    const data = JSON.parse(script.textContent ?? "") as { h?: Record<string, { moduleUrl?: string; exportName?: string; props?: AppRootProps }> };
    for (const entry of Object.values(data.h ?? {})) {
      if (`${entry.moduleUrl ?? ""}#${entry.exportName ?? ""}` === APP_ROOT_ENTRY && entry.props) return entry.props;
    }
  } catch {
    // An unreadable data block is no server document.
  }
  return null;
}

/**
 * A pane document drew its frames from one read (S2): the pane's store and the frames' ETag start from
 * it, with the src the pane route will draw. Boot only: a soft navigation to another pane reconciles
 * the DOM and does not hydrate it, so the stores re-seed (lib/identity-seed.ts) and the pane loads.
 */
function primePane(props: AppRootProps): void {
  const route = matchAppRoute(new URL(props.path, window.location.origin));
  if (route?.kind !== "pane" || props.pane === undefined) return;
  // Hydrate in the mode the document was drawn in (a first visit has no prefs cookie yet), for this
  // page only: priming leaves the stored switch alone.
  paneFrames.prime(props.pane.frames ? "1" : "0");
  const { scope } = address.get();
  paneStore(paneScopeKey(scope, route.paneId)).set({ data: props.pane.read, error: undefined, status: undefined });
  const agent = parseAgent(findPane(props.snapshot, route.paneId)?.agent, displayPrefs.get().rawTerminal);
  primePaneFrames(paneFrameSrc(route.paneId, scope, PANE_LINES, agent), route.paneId, scope, props.pane.etag, props.pane.read);
}

// `?frames=0|1` sets the pane frames switch for this device before anything renders (lib/prefs.ts).
applyFramesParam(new URL(window.location.href), false);

const fromServer = serverProps();
// Give the stores what the server rendered from, before anything renders (lib/identity-seed.ts).
if (fromServer !== null) {
  documentSeed.ensure(fromServer);
  primePane(fromServer);
}

startPrefSync();
startPrefCookie(basePath());
startNavTracking();
// A server document already shows its rows: let the browser paint them before the runtime hydrates
// (see `afterFirstPaint`). The static shell has nothing to show and starts at once.
if (fromServer !== null) await afterFirstPaint();
let app: AppRuntime = start();
let ready = settle(app, fromServer !== null);

/**
 * Resolves after the browser's first frame with the server's HTML in it, and never later than
 * FIRST_PAINT_WAIT_MS. WHY: a WARM load has this module cached, so it ran before the first frame, and
 * `run()` (the store reads, the hydrating render) held the paint of rows the server had already drawn
 * (round 8: first row 207 ms warm against 107 cold at 4x). Two animation frames put the first paint
 * behind us. The timer is the ceiling: animation frames do not run in a hidden tab, and a late
 * hydration must not wait for one.
 */
function afterFirstPaint(): Promise<void> {
  const done = Promise.withResolvers<void>();
  const timer = setTimeout(() => done.resolve(), FIRST_PAINT_WAIT_MS);
  requestAnimationFrame(() => requestAnimationFrame(() => done.resolve()));
  return done.promise.finally(() => clearTimeout(timer));
}
function start(): AppRuntime {
  const next = startAppRuntime(mountedRouter, loadModule);
  next.addEventListener("error", (event) => {
    console.error("Collie: the app runtime failed", event.error);
    // A vdom that Translate or an extension corrupted fails every later tap: reload once (lib/reconcile-reload.ts).
    if (event.error instanceof Error) reloadOnReconcileError(event.error, tabStorage(), reloadDocument);
  });
  return next;
}

/**
 * Resolves when the first screen is up. A server document is up once its island hydrated; the
 * static shell draws the splash, then routes (remix/spa's `run` did this with `fallback`).
 */
async function settle(runtime: AppRuntime, hydrated: boolean): Promise<void> {
  await runtime.ready();
  if (hydrated) return;
  await runtime.frames.top.replace(<BootSplash />);
  await runtime.frames.top.reload();
}

/**
 * Dispose the runtime and start it again over the SAME router, which keeps the location (the spike's
 * probe 4 remount: dispose, then `run()` again; the route re-renders, the stores keep their data).
 * The idle lock does NOT use this: ADR 0007 keeps the tree mounted under the cover so nothing local
 * is lost. It is the recovery path for a runtime that failed. It always boots as the static shell.
 */
export async function remount(): Promise<void> {
  app.dispose();
  document.body.replaceChildren();
  app = start();
  ready = settle(app, false);
  await ready;
  quietCurrentEntry();
}

startPolling();
startIdleLock();
startUpdates();
await ready;
// A screen is up: the next reconcile fault in this tab may reload once again.
clearReconcileReloadFlag(tabStorage());
// The runtime stamped the first entry `resetScroll: true` as it started; a back move onto it reads that.
quietCurrentEntry();
