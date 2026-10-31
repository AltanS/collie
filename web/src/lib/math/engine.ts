import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import type { MathEngine } from "@/lib/design";

// THE MATH ENGINES, loaded on demand. A device chooses Off, KaTeX or MathJax (Settings → Appearance,
// `DesignPrefs.math`). Off is the default and loads nothing: neither engine is in the main bundle or
// the precache (vite.config.ts puts both under `math/`). A chosen engine is imported once, the first
// time something asks for it, and kept for the life of the page.
//
// Both engines meet the renderer at the same seam: TeX in, React nodes out, or `null` when the TeX
// does not typeset, and the caller then shows the source as text. Neither writes HTML into the DOM:
// each one's markup is parsed into a hast tree and turned into React elements (math-markup.ts), so
// the "pane text is React text nodes" rule (ARCHITECTURE.md §6) still has no exception.

/** What an engine made of one formula: React nodes, or `null` when it does not typeset. */
export type Typeset = ReactNode | null;

export interface MathRenderer {
  /**
   * Typeset `text`. Synchronous when it can be. MathJax answers with a promise when the formula needs
   * a font range it has not fetched yet (`\mathbb`, `\mathfrak`, …); every later formula in that range
   * is synchronous again.
   */
  render(text: string, display: boolean): Typeset | Promise<Typeset>;
}

type Loaded = Exclude<MathEngine, "off">;

const loaders = {
  katex: () => import("./katex").then((m) => m.katexRenderer),
  mathjax: () => import("./mathjax").then((m) => m.mathjaxRenderer()),
} satisfies Record<Loaded, () => Promise<MathRenderer>>;

const ready = new Map<Loaded, MathRenderer>();
const pending = new Map<Loaded, Promise<MathRenderer | null>>();
// An engine whose import failed stays failed for the life of the page: formulas show their source.
// A retry could not be trusted to bring the engine back whole, because Vite's preload helper marks a
// dependency as seen BEFORE it loads, so a second import after a failed stylesheet would get KaTeX's
// code without its CSS. The next page load starts clean.
const failed = new Set<Loaded>();
const listeners = new Set<() => void>();

/**
 * Start loading `engine` if it is not loaded, loading or failed. Called at startup for the stored
 * choice (main.tsx), when the choice changes and when a formula first asks, so a message's first
 * paint usually finds the engine already there. A failed load (offline with nothing cached, or a page
 * older than the build on the server) resolves to `null`, and the formulas keep their source.
 */
export function loadMathEngine(engine: MathEngine): Promise<MathRenderer | null> {
  if (engine === "off" || failed.has(engine)) return Promise.resolve(null);
  const have = ready.get(engine);
  if (have !== undefined) return Promise.resolve(have);
  const inFlight = pending.get(engine);
  if (inFlight !== undefined) return inFlight;
  const load = loaders[engine]()
    .then((renderer) => {
      ready.set(engine, renderer);
      for (const fn of listeners) fn();
      return renderer;
    })
    .catch(() => {
      failed.add(engine);
      return null;
    })
    .finally(() => pending.delete(engine));
  pending.set(engine, load);
  return load;
}

/**
 * Whether a `vite:preloadError` came from a math engine. main.tsx skips its reload for one: a reload
 * cannot bring an engine that is not cached to an offline phone, and an engine is optional, so its
 * failure costs typesetting and nothing else. Vite names the file for a stylesheet, and Chromium and
 * Firefox name it for a module. Safari names no file, so an error that names none, raised while an
 * engine is loading, is counted as the engine's.
 */
export function isMathLoadError(error: Error): boolean {
  if (error.message.includes("/math/")) return true;
  return pending.size > 0 && !/https?:\/\//.test(error.message);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The renderer for `engine`, or `null` while it loads, after it failed, and for Off. Asking starts
 * the load, after the render rather than during it.
 */
export function useMathRenderer(engine: MathEngine): MathRenderer | null {
  const get = () => (engine === "off" ? null : (ready.get(engine) ?? null));
  const renderer = useSyncExternalStore(subscribe, get, () => null);
  useEffect(() => {
    if (renderer === null) void loadMathEngine(engine);
  }, [renderer, engine]);
  return renderer;
}

/** Test seam: forget every loaded engine, as if the page had just opened. */
export function __resetMathEngines(): void {
  ready.clear();
  pending.clear();
  failed.clear();
}
