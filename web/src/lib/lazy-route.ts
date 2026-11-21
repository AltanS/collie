import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

import { reloadOnChunkError, type ChunkPreload } from "./chunk-reload";

// A SCREEN THAT LOADS ON DEMAND (ADR 0169). The route table (router.tsx) names a lazy screen with one
// line, `lazy: lazyScreen(() => import("@/routes/x"), (m) => m.XRoute)`, and React Router fetches the
// chunk when a navigation first matches the route: the old screen stays up and the mark turns while it
// loads, as it does for a loader. Only the component is lazy; a route's loader stays in the table.
//
// Two ways in, one chunk. A NAVIGATION goes through `reloadOnChunkError`: an old page asking for a chunk
// the new build dropped reloads once onto the new build. The BACKGROUND PRELOAD (lib/route-preload.ts)
// takes the bare import that `preloadOf` hands back, and never reloads.

/** What React Router's `lazy` receives from this helper. */
export type LazyScreen = () => Promise<{ Component: ComponentType }>;

const PRELOADS = new WeakMap<object, ChunkPreload>();

/** The `lazy` of a route whose screen is `pick(await load())`. */
export function lazyScreen<M>(load: () => Promise<M>, pick: (module: NonNullable<M>) => ComponentType): LazyScreen {
  const lazy: LazyScreen = async () => {
    // Undefined when Vite's `vite:preloadError` listener already started the reload: it cancels the
    // rethrow then (lib/chunk-reload.ts `onPreloadError`), and the import resolves with nothing.
    const module: M | undefined = await reloadOnChunkError(load);
    // The page is reloading: keep the old screen until it goes, rather than flash the error screen.
    if (module === undefined || module === null) return new Promise<never>(() => undefined);
    return { Component: pick(module) };
  };
  PRELOADS.set(lazy, async () => {
    await load();
  });
  return lazy;
}

/** The bare import behind a route's `lazy`, or null when the `lazy` did not come from `lazyScreen`. */
export function preloadOf(lazy: RouteObject["lazy"]): ChunkPreload | null {
  if (lazy === undefined) return null;
  return PRELOADS.get(lazy) ?? null;
}

/** Whether a route's `lazy` came from `lazyScreen`. */
export function isLazyScreen(lazy: RouteObject["lazy"]): lazy is LazyScreen {
  return lazy !== undefined && PRELOADS.has(lazy);
}
