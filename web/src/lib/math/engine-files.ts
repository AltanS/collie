import type { Root } from "hast";

// THE MATH ENGINES' FILES AND THEIR CONTRACT, the one list the app's loader (engine.ts), the engines'
// own build (vite.math.ts) and the release check (scripts/math-pack.ts) all read (ADR 0132).
//
// Each engine is a SELF-CONTAINED bundle under `math/<engine>/`, built apart from the app: nothing
// under `math/` imports a file outside `math/`, and the two engines share no file. So the one pack the
// release builds fits every platform's app build, whatever that build's own chunks are called.
//
// THE CONTRACT. `math/<engine>/<engine>.js` is an ES module that exports one function:
//
//     typeset(tex: string, display: boolean): Root | null | Promise<Root | null>
//
// `Root` is a hast tree (github.com/syntax-tree/hast) of the engine's markup for one formula, plain
// objects, which the app turns into React elements itself. `null` means the TeX does not typeset, and
// the app then shows the source. A promise means the engine first fetches a file of its own (a MathJax
// font range under `math/mathjax/`). Its stylesheet, `math/<engine>/<engine>.css`, is the app's to
// link; its fonts are files beside it. Nothing else is promised, so either side may change freely
// behind this one function.

/** One formula, as an engine typeset it. */
export type MathMarkup = Root | null;

/** What `math/<engine>/<engine>.js` exports. */
export interface MathEngineModule {
  typeset(tex: string, display: boolean): MathMarkup | Promise<MathMarkup>;
}

/** The engines a device can choose besides Off. */
export const MATH_ENGINE_NAMES = ["katex", "mathjax"] as const;

export type MathEngineName = (typeof MATH_ENGINE_NAMES)[number];

/** The files of one engine the loader names, as paths under the web root. */
export interface MathEngineFiles {
  module: string;
  stylesheet: string;
}

/** Where the loader finds an engine, under the app's mount. */
export function mathEngineFiles(engine: MathEngineName): MathEngineFiles {
  return { module: `math/${engine}/${engine}.js`, stylesheet: `math/${engine}/${engine}.css` };
}
