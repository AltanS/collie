// The islands boot (S3): an islands document is server HTML with a few `clientEntry` islands in it
// (ssr/islands-document.tsx). This starts the runtime over it, ONCE per page (`run()` is never called
// again; a soft navigation diffs the next document into the same runtime).
//
// THE ORDER MATTERS.
//   1. `?frames=` and `?islands=` set their switches, as on the static shell.
//   2. The stores are primed from the document's data block (islands/seed.ts), so every island's first
//      render reads what the server drew from and hydration moves nothing.
//   3. The prefs sync and the prefs cookie start (the cookie is how the bridge draws by them).
//   4. The navigate listener that turns the focus reset off is registered BEFORE `run()`, so it sees
//      each event before the runtime intercepts it (see `manualFocusReset`).
//   5. The browser paints the server HTML first (lib/first-paint.ts), then `run()` hydrates.
//   6. The beat, the idle lock and the updates start; the beat's sources are the islands' own.
import { run, type AppRuntime } from "remix/component";

import { basePath } from "@web/lib/base-path";

import { afterFirstPaint } from "../lib/first-paint";
import { startIdleLock } from "../lib/idle";
import { quietCurrentEntry } from "../lib/navigate";
import { startPolling } from "../lib/polling";
import { applyFramesParam, applyIslandsParam, paneFrames, startPrefCookie, startPrefSync } from "../lib/prefs";
import { clearReconcileReloadFlag, reloadOnReconcileError, tabStorage } from "../lib/reconcile-reload";
import { startUpdates } from "../update/boot";
import { reloadDocument } from "../update/pwa";
import { readDocumentData } from "./document-data";
import { loadIsland } from "./registry";
import { resolveIslandFrame } from "./resolver";
import { seedFromDocument } from "./seed";

/**
 * Every navigation the runtime intercepts resets focus by default, which puts it on the body: a
 * keyboard or screen reader user starts again from the top of every page. The runtime calls
 * `event.intercept()` itself (its `interceptNavigation`); this gives each event, before the runtime
 * sees it, an `intercept` that adds `focusReset: "manual"`. Only intercepted navigations are touched.
 * The gestures island then puts focus on the page's landing (islands/gestures.tsx).
 */
function manualFocusReset(): void {
  if (!("navigation" in window)) return;
  window.navigation.addEventListener("navigate", (event) => {
    const intercept = event.intercept.bind(event);
    Object.defineProperty(event, "intercept", {
      configurable: true,
      value: (options?: NavigationInterceptOptions) => intercept({ ...options, focusReset: "manual" }),
    });
  });
}

let app: AppRuntime | undefined;

/** Read by e2e/islands.spec.ts: how many times `run()` was called on this page. */
const boots = { runs: 0 };
Object.assign(globalThis, { __collieIslandRuns: boots });

export async function bootIslands(): Promise<void> {
  const url = new URL(window.location.href);
  applyFramesParam(url, false);
  applyIslandsParam(url, false);
  const data = readDocumentData();
  if (data === null) {
    // A garbled block: the static shell's boot draws the page instead.
    const { bootSpa } = await import("../spa-boot");
    return bootSpa();
  }
  // The document was drawn in a mode (a first visit has no cookie yet): hydrate in it, for this page only.
  if (data.pane !== undefined) paneFrames.prime(data.pane.frames ? "1" : "0");
  await seedFromDocument(data);
  startPrefSync();
  startPrefCookie(basePath());
  manualFocusReset();
  await afterFirstPaint();
  if (app !== undefined) return;
  boots.runs++;
  app = run({ loadModule: loadIsland, resolveFrame: resolveIslandFrame });
  app.addEventListener("error", (event) => {
    console.error("Collie: the islands runtime failed", event.error);
    if (event.error instanceof Error) reloadOnReconcileError(event.error, tabStorage(), reloadDocument);
  });
  startPolling();
  startIdleLock();
  startUpdates();
  await app.ready();
  clearReconcileReloadFlag(tabStorage());
  quietCurrentEntry();
}
