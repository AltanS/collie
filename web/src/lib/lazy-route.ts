import type { ComponentType } from "react";
import type { RouteObject } from "react-router";

import { reloadOnChunkError, type ChunkPreload } from "./chunk-reload";
import { t } from "./i18n";

// A SCREEN THAT LOADS ON DEMAND (ADR 0169). The route table (router.tsx) names a lazy screen with one
// line, `lazy: lazyScreen(() => import("@/routes/x"), (m) => m.XRoute)`, and React Router fetches the
// chunk when a navigation first matches the route: the old screen stays up and the mark turns while it
// loads, as it does for a loader. Only the component is lazy; a route's loader stays in the table.
//
// A chunk that is not a route (a feature's own door, e.g. a search loaded on the first typed word) uses
// `lazyChunk(load)` the same way: the returned function imports through `reloadOnChunkError`, and the
// chunk joins the background preload.
//
// Two ways in, one chunk. A NAVIGATION goes through `reloadOnChunkError`: an old page asking for a chunk
// the new build dropped reloads once onto the new build. The BACKGROUND PRELOAD (lib/route-preload.ts)
// takes the bare import that `preloadOf` hands back, and never reloads.

/** What React Router's `lazy` receives from this helper. */
export type LazyScreen = () => Promise<{ Component: ComponentType }>;

const PRELOADS = new WeakMap<object, ChunkPreload>();

/** How long a navigation waits for a reload that was started for a missing chunk before it fails. */
export const RELOAD_CEILING_MS = 10_000;

/**
 * The import resolved with nothing: Vite's `vite:preloadError` listener started a reload and cancelled the
 * rethrow (lib/chunk-reload.ts `onPreloadError`, which does that only when it reloads; a held tab gets the
 * error itself). Keep the old screen while the page goes, rather than flash the error screen. A reload that
 * never takes the page (a `beforeunload` prompt cancelled it) must not leave the navigation hanging, so after
 * RELOAD_CEILING_MS it fails, and the route's error screen shows with its reload link.
 */
function waitForTheReload(): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error(t("apiError.unknown"))), RELOAD_CEILING_MS);
  });
}

/** The `lazy` of a route whose screen is `pick(await load())`. */
export function lazyScreen<M>(load: () => Promise<M>, pick: (module: NonNullable<M>) => ComponentType): LazyScreen {
  const lazy: LazyScreen = async () => {
    // Undefined when Vite's `vite:preloadError` listener already started the reload (`waitForTheReload`).
    const module: M | undefined = await reloadOnChunkError(load);
    if (module === undefined || module === null) return waitForTheReload();
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

// The preloads of `lazyChunk` doors. Collected until the background preload starts, then handed straight
// to it (lib/route-preload.ts `drainChunkPreloads`): a door whose module is first evaluated during the
// preload, because it lives in a lazy screen's chunk, still gets its chunk fetched in the same run.
let pendingChunks: ChunkPreload[] = [];
let chunkSink: ((load: ChunkPreload) => void) | null = null;

/**
 * A dynamic import that is not a route: call the returned function where the feature needs the module.
 * It imports through `reloadOnChunkError`, and the chunk is fetched by the background preload. Call
 * `lazyChunk` at module scope, once per chunk.
 */
export function lazyChunk<M>(load: () => Promise<M>): () => Promise<M> {
  const bare: ChunkPreload = async () => {
    await load();
  };
  if (chunkSink === null) pendingChunks.push(bare);
  else chunkSink(bare);
  return async () => {
    const module: M | undefined = await reloadOnChunkError(load);
    if (module === undefined || module === null) return waitForTheReload();
    return module;
  };
}

/** For the preload: every `lazyChunk` door so far; any later one goes to `sink`. */
export function drainChunkPreloads(sink: (load: ChunkPreload) => void): ChunkPreload[] {
  chunkSink = sink;
  const drained = pendingChunks;
  pendingChunks = [];
  return drained;
}

/** Test seam: forget the `lazyChunk` doors and the sink. */
export function __resetChunkPreloads(): void {
  pendingChunks = [];
  chunkSink = null;
}
