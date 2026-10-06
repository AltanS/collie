// Boot. Starts the polling beat and the idle lock, then the remix/spa runtime over the module-scope
// router. The runtime renders into the document's top frame (<body>); the router outlives it.
import "./app.css";

import { run, type Runtime } from "remix/spa";

import { startIdleLock } from "./lib/idle";
import { startPolling } from "./lib/polling";
import { mountedRouter } from "./router";
import { startUpdates } from "./update/boot";
import { BootSplash } from "./shell";

let app: Runtime = start();

function start(): Runtime {
  const next = run(mountedRouter, { fallback: <BootSplash /> });
  next.addEventListener("error", (event) => {
    console.error("Collie: the app runtime failed", event.error);
  });
  return next;
}

/**
 * Dispose the runtime and start it again over the SAME router, which keeps the location (the spike's
 * probe 4 remount: dispose, then `run()` again; the route re-renders, the stores keep their data).
 * The idle lock does NOT use this: ADR 0007 keeps the tree mounted under the cover so nothing local
 * is lost. It is the recovery path for a runtime that failed.
 */
export async function remount(): Promise<void> {
  app.dispose();
  document.body.replaceChildren();
  app = start();
  await app.ready();
}

startPolling();
startIdleLock();
startUpdates();
await app.ready();
