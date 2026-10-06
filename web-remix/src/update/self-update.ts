// The stale-app controller: watches the server build on every snapshot poll and opens the update
// sheet when the bridge serves a different app than the one running here.
//
// One observation per snapshot answer: the shell polls `/api/snapshot` on the beat (lib/polling.ts),
// lib/api.ts records the `X-Collie-Build` header into `serverBuild`, and `loadSnapshot` stamps
// `snapshotAt`, which notifies on every answer (a 304 and an unchanged body included; the `snapshot`
// store itself publishes only on a change). The comparison and its two-poll
// hysteresis are pure (update/build-check.ts).
//
// What differs from web/src/lib/self-update.ts, on purpose (phase B3 brief): web/ reloads on its own
// when nothing holds the page, and shows a band only when it cannot. This shell shows a blocking sheet
// with one Reload button instead, and never reloads on its own. The once-per-build guard is the same
// sessionStorage key, and it changes what the SECOND tap does: a page that already reloaded for this
// build and came back stale drops the precache (update/pwa.ts `forceReload`) instead of looping.
import { serverBuild } from "../lib/api";
import { snapshot, snapshotAt } from "../lib/data";
import { createStore } from "../lib/store";
import { FRESH, observeBuild, type BuildWatch } from "./build-check";
import { checkForUpdate } from "./pwa";

/** How recent a snapshot answer must be to count as "the bridge is answering" (web/'s BRIDGE_FRESH_MS). */
const BRIDGE_FRESH_MS = 20_000;

/** The confirmed stale server build id, or null while this app is current. The sheet reads it. */
export const staleBuild = createStore<string | null>(null);

/** Same key as web/src/lib/self-update.ts, so a reload by either shell counts for both. */
const reloadedKey = (id: string): string => `collie:auto-reloaded-for=${id}`;

function reloadedFor(id: string): boolean {
  try {
    return sessionStorage.getItem(reloadedKey(id)) !== null;
  } catch {
    return false;
  }
}

function markReloadedFor(id: string): void {
  try {
    sessionStorage.setItem(reloadedKey(id), String(Date.now()));
  } catch {
    // storage disabled: the reload still happens, it just cannot guard against a second one
  }
}

/** The id this bundle was built as. Read at call time so a unit test can import the module. */
function bundleId(): string {
  return __BUILD_INFO__.id;
}

let watch: BuildWatch = FRESH;

function observe(): void {
  const loaded = snapshot.get();
  if (loaded.error !== undefined || snapshotAt.get() === 0) return;
  watch = observeBuild(watch, bundleId(), serverBuild.get());
  staleBuild.set(watch.confirmed ?? null);
}

/** The sheet's button. Marks this build as reloaded-for before it goes. */
export function reloadOntoServerBuild(): void {
  const id = staleBuild.get();
  const bypass = id !== null && reloadedFor(id);
  if (id !== null) markReloadedFor(id);
  const at = snapshotAt.get();
  void checkForUpdate({ bypass, bridgeAnswering: at > 0 && Date.now() - at < BRIDGE_FRESH_MS });
}

let started = false;

export function startSelfUpdate(): void {
  if (started) return;
  started = true;
  // Freshness, not the snapshot: the snapshot store publishes only on a changed body, and the
  // two-poll hysteresis needs one observation per ANSWER.
  snapshotAt.subscribe(observe);
  observe();
}
