import type { RouteObject } from "react-router";

import { preloadQuietly, type ChunkPreload } from "./chunk-reload";
import { __resetChunkPreloads, drainChunkPreloads, preloadOf } from "./lazy-route";

// EVERY LAZY SCREEN IS FETCHED IN THE BACKGROUND ONCE THE APP IS IDLE (ADR 0169). The split only moves
// bytes out of the first file: after a few idle seconds the tab holds every screen in memory, as it did
// when they were all in the main chunk. That matters where the service worker cannot help: a tab that
// outlives an update (the new worker drops the old precache) and a page with no service worker.
//
// Once per page load, after the first paint, when the browser is idle (`requestIdleCallback`; Safari has
// none, so a timer of IDLE_FALLBACK_MS stands in), and never while the document is hidden: a hidden tab
// waits for `visibilitychange`, also between two chunks. The chunks go one after another, so the preload
// never competes with itself, and a failure never reloads (lib/chunk-reload.ts `preloadQuietly`). A failed
// chunk is tried again, at most PRELOAD_RETRY_ROUNDS times: offline, on the `online` event, then idle;
// online, on the next idle moment. With Save-Data on (`navigator.connection.saveData`) nothing is
// preloaded: each screen loads when it is opened. The list is the route table's lazy routes plus every
// `lazyChunk` door (lib/lazy-route.ts).

/** Safari's stand-in for `requestIdleCallback`. */
export const IDLE_FALLBACK_MS = 2_000;

/** How many times the preload tries a failed chunk again, after its first try. */
export const PRELOAD_RETRY_ROUNDS = 3;

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

/** The page's network, as the scheduler reads it. */
export interface PreloadWindow {
  addEventListener(type: "online", listener: () => void): void;
  removeEventListener(type: "online", listener: () => void): void;
}

/** What the scheduler needs from the page. A seam for the tests. */
export interface PreloadHost {
  readonly document: PreloadDocument;
  readonly window: PreloadWindow;
  /** Absent where the browser has no idle callback (Safari). */
  readonly requestIdleCallback?: (callback: () => void) => void;
  readonly setTimeout: (callback: () => void, ms: number) => void;
  readonly onLine: () => boolean;
  /** The person asked for less data (`navigator.connection.saveData`). */
  readonly saveData: boolean;
}

/** `navigator.connection` is not in TypeScript's DOM library (Chromium only). */
interface PreloadNavigator {
  readonly onLine: boolean;
  readonly connection?: { readonly saveData?: boolean };
}

function browserHost(): PreloadHost {
  const idle = "requestIdleCallback" in window ? (cb: () => void) => void window.requestIdleCallback(cb) : undefined;
  const nav: PreloadNavigator = navigator;
  return {
    document,
    window,
    requestIdleCallback: idle,
    setTimeout: (cb, ms) => void window.setTimeout(cb, ms),
    onLine: () => nav.onLine,
    saveData: nav.connection?.saveData === true,
  };
}

/** Resolves at the next idle moment of a shown document; a hidden one waits for `visibilitychange` first. */
function whenIdleAndShown(host: PreloadHost): Promise<void> {
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
      resolve();
    };
    whenIdle();
  });
}

/** Resolves once the page is online, at once when it is. */
function whenOnline(host: PreloadHost): Promise<void> {
  if (host.onLine()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onOnline = (): void => {
      host.window.removeEventListener("online", onOnline);
      resolve();
    };
    host.window.addEventListener("online", onOnline);
  });
}

// One queue for the page: the route table's chunks, then every `lazyChunk` door (lib/lazy-route.ts), also
// one first evaluated during the run. A door added after the run ended starts a short run of its own.
let started = false;
let queue: ChunkPreload[] = [];
let failed: ChunkPreload[] = [];
let retryRounds = 0;
let pumping = false;

/** Fetch the queue, then try the failed chunks again, round by round. One pump at a time. */
async function pump(host: PreloadHost): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (let round = 0; round <= PRELOAD_RETRY_ROUNDS; round += 1) {
      for (let load = queue.shift(); load !== undefined; load = queue.shift()) {
        if (host.document.visibilityState === "hidden") await whenIdleAndShown(host);
        if (!(await preloadQuietly(load))) failed.push(load);
      }
      if (failed.length === 0 || retryRounds >= PRELOAD_RETRY_ROUNDS) return;
      retryRounds += 1;
      await whenOnline(host);
      await whenIdleAndShown(host);
      queue.push(...failed);
      failed = [];
    }
  } finally {
    pumping = false;
  }
}

/**
 * Preload every load, once per page load. Returns the run's promise, which settles when the chunks and
 * their retries are done, or null when a run has already started (a second call is a no-op).
 */
export function schedulePreload(loads: readonly ChunkPreload[], host: PreloadHost = browserHost()): Promise<void> | null {
  if (started) return null;
  started = true;
  if (host.saveData) return Promise.resolve();
  return whenIdleAndShown(host).then(() => {
    queue.push(...loads);
    queue.push(
      ...drainChunkPreloads((load) => {
        queue.push(load);
        void pump(host);
      }),
    );
    return pump(host);
  });
}

/** Test seam: forget that a run started, every queued chunk and every retry. */
export function __resetPreload(): void {
  started = false;
  queue = [];
  failed = [];
  retryRounds = 0;
  pumping = false;
  __resetChunkPreloads();
}
