import { useEffect, useSyncExternalStore } from "react";

import type { GlyphSetId } from "@/lib/glyph-sets";

import type { GlyphSetData } from "./glyph-data";

// THE GLYPH SET CHUNKS, loaded on demand (ADR 0137). Lucide is in the entry bundle and needs nothing.
// Every other set is one lazy chunk under `glyphs/` (web/vite-glyphs.ts builds it), fetched the first
// time a worn or previewed theme names it, and kept here for the life of the page.
//
// UNTIL A SET ARRIVES, and when it cannot arrive (offline right after an update: the chunks are not
// in the precache and src/sw.ts empties their cache on an update), every icon draws its lucide glyph.
// The box is the caller's size class either way, so nothing moves when the set lands. A failed set is
// not fetched again in this page; the next page load tries again.

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

const loaded = new Map<ChunkedGlyphSetId, GlyphSetData>();
const asked = new Map<ChunkedGlyphSetId, Promise<void>>();
const listeners = new Set<() => void>();
/** Bumped on every arrival, so a snapshot of the cache is a number React can compare. */
let version = 0;

function subscribe(fn: () => void): () => void {
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
 * Start fetching the chunk of `id`, once per page. Never rejects: a set that cannot load leaves the
 * lucide glyphs on screen, which is the whole of the fallback.
 */
export function preloadGlyphSet(id: GlyphSetId): Promise<void> {
  if (id === "lucide") return Promise.resolve();
  const started = asked.get(id);
  if (started !== undefined) return started;
  const fetching = arrive(id);
  asked.set(id, fetching);
  return fetching;
}

async function arrive(id: ChunkedGlyphSetId): Promise<void> {
  try {
    loaded.set(id, await loadChunk(id));
  } catch {
    // The lucide glyphs stay (see above).
    return;
  }
  version += 1;
  for (const fn of listeners) fn();
}

/** The data of a set, reactive: null until its chunk arrives, then the data. Asks for the chunk. */
export function useGlyphSetData(id: GlyphSetId): GlyphSetData | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  useEffect(() => {
    void preloadGlyphSet(id);
  }, [id]);
  return glyphSetData(id);
}

/** Forget every loaded set. Tests only. */
export function __resetGlyphSets(): void {
  loaded.clear();
  asked.clear();
  version = 0;
}
