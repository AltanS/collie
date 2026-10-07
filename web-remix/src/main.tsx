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

import { markLive } from "@web/lib/connection-health";
import { basePath } from "@web/lib/base-path";

import { APP_ROOT_ENTRY, AppRoot, type AppRootProps } from "./app-root";
import { startAppRuntime } from "./lib/app-runtime";
import { config, noteAddress, snapshot, snapshotAt } from "./lib/data";
import { startIdleLock } from "./lib/idle";
import { quietCurrentEntry } from "./lib/navigate";
import { installPolyfills } from "./lib/polyfills";
import { startPrefCookie, startPrefSync } from "./lib/prefs";
import { startPolling } from "./lib/polling";
import { mountedRouter } from "./router";
import { startUpdates } from "./update/boot";
import { BootSplash } from "./shell";
import { startNavTracking } from "./shell/screen-transition";

installPolyfills();

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

/** Give the stores what the server rendered from, before anything renders. */
function prime(props: AppRootProps): void {
  noteAddress(new URL(props.path, window.location.origin));
  snapshot.set({ data: props.snapshot, error: undefined, status: undefined });
  snapshotAt.set(props.snapshotAt);
  config.set({ data: props.config, error: undefined, status: undefined });
  // The snapshot is a live answer from the bridge, as a poll's would be.
  if (props.snapshot.bridge !== "disconnected") markLive();
}

const fromServer = serverProps();
if (fromServer !== null) prime(fromServer);

startPrefSync();
startPrefCookie(basePath());
startNavTracking();
let app: AppRuntime = start();
let ready = settle(app, fromServer !== null);

function start(): AppRuntime {
  const next = startAppRuntime(mountedRouter, loadModule);
  next.addEventListener("error", (event) => {
    console.error("Collie: the app runtime failed", event.error);
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
// The runtime stamped the first entry `resetScroll: true` as it started; a back move onto it reads that.
quietCurrentEntry();
