// The reload hold: named reasons the page must not be reloaded out from under the operator (an
// unsent draft, an upload). web/src/lib/reload-guard.ts without its React hook.
//
// A service-worker swap (update/pwa.ts) reloads only when no hold is left. The update sheet's own
// button is the operator asking, so it does not wait on a hold.
import { createStore } from "../lib/store";

const holds = new Set<string>();

/** True while any hold is set. A store so the swap can wait for the last one to clear. */
export const reloadHeld = createStore<boolean>(false);

export function holdReload(key: string): void {
  holds.add(key);
  reloadHeld.set(true);
}

export function releaseReload(key: string): void {
  holds.delete(key);
  reloadHeld.set(holds.size > 0);
}

export function isReloadHeld(): boolean {
  return holds.size > 0;
}
