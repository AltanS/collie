import { useEffect, useSyncExternalStore, type ReactNode } from "react";

import { mounted } from "@/lib/base-path";
import type { MathEngine } from "@/lib/design";
import { MAX_MATH_CHARS } from "@/lib/markdown-math";

import { mathEngineFiles, type MathEngineModule, type MathMarkup } from "./engine-files";

// THE MATH ENGINES, loaded on demand. A device chooses Off, KaTeX or MathJax (Settings → Appearance,
// `DesignPrefs.math`). Off is the default and loads nothing. A chosen engine is loaded once, the first
// time something asks for it, and kept for the life of the page.
//
// AN ENGINE IS NOT A MODULE OF THE APP. Each is a self-contained bundle under `math/<engine>/`, built
// apart from the app (vite.math.ts) and shipped as the host's math pack (ADR 0132), so this file loads
// it BY URL, `import()` of `<mount>/math/<engine>/<engine>.js`, and links its stylesheet beside it. The
// app bundle holds no engine code and no chunk under `math/`, and the pack owes nothing to the app's
// build. The module's contract, one `typeset` function, is in engine-files.ts.
//
// Both engines meet the renderer at the same seam: TeX in, React nodes out, or `null` when the TeX
// does not typeset, and the caller then shows the source as text. Neither writes HTML into the DOM:
// each one's markup arrives as a hast tree and is turned into React elements (math-markup.ts), so
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

/** Link `href` as a stylesheet, and settle when it has loaded or failed. A failed one is removed. */
function linkStylesheet(href: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener(
      "error",
      () => {
        link.remove();
        reject(new Error(`Unable to load the stylesheet ${href}`));
      },
      { once: true },
    );
    document.head.append(link);
  });
}

/** The engine's module from the host, by URL under the mount, with its stylesheet linked. */
async function importFromHost(engine: Loaded): Promise<MathEngineModule> {
  const files = mathEngineFiles(engine);
  // SAFETY: the module is the engine bundle at the path engine-files.ts names, built from katex.ts or
  // mathjax.ts, whose `typeset` is typed as the contract there. A module that broke it would throw on
  // its first formula, and the renderer below turns a throw into the formula's source.
  const [module] = await Promise.all([
    import(/* @vite-ignore */ mounted(`/${files.module}`)) as Promise<MathEngineModule>,
    linkStylesheet(mounted(`/${files.stylesheet}`)),
  ]);
  return module;
}

let importEngine: (engine: Loaded) => Promise<MathEngineModule> = importFromHost;

/** The engine's `typeset` behind the renderer's seam: the length cap, React nodes, and no throw. */
async function rendererFor(engine: Loaded): Promise<MathRenderer> {
  const [module, { markupToReact }] = await Promise.all([importEngine(engine), import("./math-markup")]);
  const settle = (markup: MathMarkup): Typeset => (markup === null ? null : markupToReact(markup));
  return {
    render(text, display) {
      if (text.length > MAX_MATH_CHARS) return null;
      try {
        const out = module.typeset(text, display);
        return out instanceof Promise ? out.then(settle, () => null) : settle(out);
      } catch {
        // An engine that throws instead of answering null: the formula shows its source.
        return null;
      }
    },
  };
}

const ready = new Map<Loaded, MathRenderer>();
const pending = new Map<Loaded, Promise<MathRenderer | null>>();
// An engine whose load failed stays failed for the life of the page: formulas show their source.
// A retry could not be trusted to bring the engine back: a browser keeps a module that failed to fetch
// in its module map, so a second `import()` of the same URL fails again without asking the network.
// The next page load starts clean.
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
  const load = rendererFor(engine)
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
 * Whether `engine` failed to load on this page. It stays failed (see `failed` above): the one way back
 * is a page load, which lib/math-pack.ts makes once when the host's pack arrives after a failure.
 */
export function mathEngineFailed(engine: MathEngine): boolean {
  return engine !== "off" && failed.has(engine);
}

/**
 * Whether a `vite:preloadError` came from a math engine. MathJax's bundle loads its font ranges
 * through Vite's preload helper, which raises that event on the window when one fails. main.tsx skips
 * its reload for one: a reload cannot bring an engine that is not cached to an offline phone, and an
 * engine is optional, so its failure costs typesetting and nothing else. Chromium and Firefox name the
 * file for a module. Safari names no file, so an error that names none, raised while an engine is
 * loading, is counted as the engine's.
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

/**
 * Test seam: where an engine's module comes from. jsdom cannot `import()` a URL, so a test hands in
 * the engine's source module (`import("@/lib/math/katex")`) or a rejection. `null` restores the host.
 */
export function __setMathEngineImport(load: ((engine: Loaded) => Promise<MathEngineModule>) | null): void {
  importEngine = load ?? importFromHost;
}

/** Test seam: forget every loaded engine, as if the page had just opened. */
export function __resetMathEngines(): void {
  ready.clear();
  pending.clear();
  failed.clear();
}
