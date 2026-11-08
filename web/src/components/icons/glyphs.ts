import { useEffect, useSyncExternalStore } from "react";

import { hasDocument } from "@/lib/env";
import type { GlyphSetId } from "@/lib/glyph-sets";

import type { GlyphSetData } from "./glyph-data";

// THE GLYPH SET CHUNKS, loaded on demand (ADR 0137). Lucide is in the entry bundle and needs nothing.
// Every other set is one lazy chunk under `glyphs/` (web/vite-glyphs.ts builds it), fetched the first
// time a worn or previewed theme names it, and kept here for the life of the page.
//
// UNTIL A SET ARRIVES, and when it cannot arrive (offline right after an update: the chunks are not
// in the precache and src/sw.ts empties their cache on an update), every icon draws its lucide glyph.
// The box is the caller's size class either way, so nothing moves when the set lands.
//
// A FAILED SET IS ASKED FOR AGAIN, A FEW TIMES. A failure is forgotten at once, so the next
// `preloadGlyphSet` (the next icon that mounts) tries again, and so does the page coming back into
// view. {@link MAX_TRIES} per set per page is the stop: a set that is truly gone costs three requests,
// never a loop. Where the browser keeps a failed `import()` for the life of the page, a retry fails
// at once and costs nothing; the next page load tries again.

type ChunkedGlyphSetId = Exclude<GlyphSetId, "lucide">;

/**
 * The import of a set's chunk. The only place those modules are named, and always as a static
 * `import()`, so each is one chunk and no id from a theme file ever becomes a path.
 */
function loadChunk(id: ChunkedGlyphSetId): Promise<GlyphSetData> {
  switch (id) {
    case "phosphor":
      return import("virtual:collie-glyphs/phosphor").then((m) => m.default);
    case "phosphor-fill":
      return import("virtual:collie-glyphs/phosphor-fill").then((m) => m.default);
    case "phosphor-duotone":
      return import("virtual:collie-glyphs/phosphor-duotone").then((m) => m.default);
    case "iconoir":
      return import("virtual:collie-glyphs/iconoir").then((m) => m.default);
  }
}

/** The loader in use: {@link loadChunk}, or a test's stand-in. */
let load = loadChunk;

/** The most times one page asks for one set's chunk. */
export const MAX_TRIES = 3;

const loaded = new Map<ChunkedGlyphSetId, GlyphSetData>();
/** The fetch in flight, or the one that arrived. A failed fetch leaves this map at once. */
const asked = new Map<ChunkedGlyphSetId, Promise<void>>();
/** How many times this page asked for each set. */
const tries = new Map<ChunkedGlyphSetId, number>();
/** The sets whose last fetch failed: the page coming back into view asks for each of them once. */
const failed = new Set<ChunkedGlyphSetId>();
const listeners = new Set<() => void>();
/** Bumped on every arrival, so a snapshot of the cache is a number React can compare. */
let version = 0;

/** Hear each arrival of a set. Returns the unsubscribe. */
export function subscribeGlyphSets(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getVersion(): number {
  return version;
}

/** The data of a set, or null while it loads, after it failed, and for lucide. */
export function glyphSetData(id: GlyphSetId): GlyphSetData | null {
  return id === "lucide" ? null : (loaded.get(id) ?? null);
}

/**
 * Start fetching the chunk of `id`. Never rejects: a set that cannot load leaves the lucide glyphs on
 * screen, which is the whole of the fallback. A call while a fetch is in flight, or after the set
 * arrived, shares it; a call after a failure tries again, up to {@link MAX_TRIES} times in this page.
 */
export function preloadGlyphSet(id: GlyphSetId): Promise<void> {
  if (id === "lucide") return Promise.resolve();
  const started = asked.get(id);
  if (started !== undefined) return started;
  const tried = tries.get(id) ?? 0;
  if (tried >= MAX_TRIES) return Promise.resolve();
  tries.set(id, tried + 1);
  const fetching = arrive(id);
  asked.set(id, fetching);
  return fetching;
}

async function arrive(id: ChunkedGlyphSetId): Promise<void> {
  try {
    loaded.set(id, await load(id));
  } catch {
    // The lucide glyphs stay (see above), and the next ask tries again.
    asked.delete(id);
    failed.add(id);
    retryWhenVisible();
    return;
  }
  failed.delete(id);
  version += 1;
  notify();
}

/** Tell every subscriber. One that throws neither skips the others nor rejects the fetch. */
function notify(): void {
  // A copy: a subscriber may unsubscribe while it is told.
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch (err) {
      console.error("[glyphs] a subscriber threw", err);
    }
  }
}

let watching = false;

/** Once per page, on the first failure: when the page comes back into view, ask for each failed set again. */
function retryWhenVisible(): void {
  if (watching || !hasDocument()) return;
  watching = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const id of Array.from(failed)) void preloadGlyphSet(id);
  });
}

/**
 * Wait for the set `id`, at most `ms`. For the first paint (main.tsx): a set already in the browser's
 * cache lands in a few milliseconds, so the app paints its icons in it and never in lucide first; a
 * set that is slow or gone holds the paint no longer than `ms`. Lucide resolves at once.
 */
export function glyphSetSettled(id: GlyphSetId, ms: number): Promise<void> {
  if (id === "lucide") return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([preloadGlyphSet(id), cap]).finally(() => clearTimeout(timer));
}

/** The data of a set, reactive: null until its chunk arrives, then the data. Asks for the chunk. */
export function useGlyphSetData(id: GlyphSetId): GlyphSetData | null {
  useSyncExternalStore(subscribeGlyphSets, getVersion, getVersion);
  useEffect(() => {
    void preloadGlyphSet(id);
  }, [id]);
  return glyphSetData(id);
}

/** Put a stand-in for the chunk import, or `null` for the real one. Tests only. */
export function __setGlyphLoader(fn: ((id: ChunkedGlyphSetId) => Promise<GlyphSetData>) | null): void {
  load = fn ?? loadChunk;
}

/** Forget every loaded set. Tests only. */
export function __resetGlyphSets(): void {
  loaded.clear();
  asked.clear();
  tries.clear();
  failed.clear();
  version = 0;
}
