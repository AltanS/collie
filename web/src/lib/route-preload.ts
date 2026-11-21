import type { RouteObject } from "react-router";

import { preloadQuietly, type ChunkPreload } from "./chunk-reload";
import { preloadOf } from "./lazy-route";

// EVERY LAZY SCREEN IS FETCHED IN THE BACKGROUND ONCE THE APP IS IDLE (ADR 0169). The split only moves
// bytes out of the first file: after a few idle seconds the tab holds every screen in memory, as it did
// when they were all in the main chunk, so an update under an open tab cannot break a later navigation.
//
// Once per page load, after the first paint, when the browser is idle (`requestIdleCallback`; Safari has
// none, so a timer of IDLE_FALLBACK_MS stands in), and never while the document is hidden: a hidden tab
// waits until it is shown. The chunks go one after another, so the preload never competes with itself,
// and a failure is swallowed without a reload (lib/chunk-reload.ts `preloadQuietly`).

/** Safari's stand-in for `requestIdleCallback`. */
export const IDLE_FALLBACK_MS = 2_000;

/** The preloads of a route table, and the paths of any lazy route that has none. */
export interface LazyLoads {
  readonly loads: ChunkPreload[];
  readonly unknown: string[];
}

/** The bare imports of every lazy route below `routes`, and the paths of any lazy no preload knows. */
export function lazyLoadsOf(routes: readonly RouteObject[]): LazyLoads {
  const found: LazyLoads = { loads: [], unknown: [] };
  const walk = (list: readonly RouteObject[], parent: string): void => {
    for (const route of list) {
      const path = route.index === true ? `${parent}(index)` : `${parent}${route.path ?? ""}/`;
      if (route.lazy !== undefined) {
        const load = preloadOf(route.lazy);
        if (load === null) found.unknown.push(path);
        else found.loads.push(load);
      }
      if (route.children !== undefined) walk(route.children, path);
    }
  };
  walk(routes, "");
  return found;
}

/** The page's visibility, as the scheduler reads it. */
export interface PreloadDocument {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** What the scheduler needs from the page. A seam for the tests. */
export interface PreloadHost {
  readonly document: PreloadDocument;
  /** Absent where the browser has no idle callback (Safari). */
  readonly requestIdleCallback?: (callback: () => void) => void;
  readonly setTimeout: (callback: () => void, ms: number) => void;
}

function browserHost(): PreloadHost {
  const idle = "requestIdleCallback" in window ? (cb: () => void) => void window.requestIdleCallback(cb) : undefined;
  return {
    document,
    requestIdleCallback: idle,
    setTimeout: (cb, ms) => void window.setTimeout(cb, ms),
  };
}

let started = false;

/**
 * Preload every load, once per page load. Returns the run's promise, or null when a run has already
 * started (a second call is a no-op).
 */
export function schedulePreload(loads: readonly ChunkPreload[], host: PreloadHost = browserHost()): Promise<void> | null {
  if (started) return null;
  started = true;
  return new Promise<void>((resolve) => {
    const whenIdle = (): void => {
      if (host.requestIdleCallback === undefined) host.setTimeout(onIdle, IDLE_FALLBACK_MS);
      else host.requestIdleCallback(onIdle);
    };
    const onShown = (): void => {
      if (host.document.visibilityState === "hidden") return;
      host.document.removeEventListener("visibilitychange", onShown);
      whenIdle();
    };
    const onIdle = (): void => {
      if (host.document.visibilityState === "hidden") {
        host.document.addEventListener("visibilitychange", onShown);
        return;
      }
      void run(loads).then(resolve);
    };
    whenIdle();
  });
}

async function run(loads: readonly ChunkPreload[]): Promise<void> {
  for (const load of loads) await preloadQuietly(load);
}

/** Test seam: forget that a run started. */
export function __resetPreload(): void {
  started = false;
}
