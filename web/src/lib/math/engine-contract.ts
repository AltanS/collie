import type { Root } from "hast";

// THE MATH ENGINES' MODULE CONTRACT (ADR 0132). Web-only: it names hast's types, which the root
// project does not install, so the file list the release check shares lives apart in engine-files.ts.
//
// `math/<engine>/<engine>.js` is an ES module that exports one function:
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
