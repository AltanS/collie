// THE MATH ENGINES' FILES, the one list the app's loader (engine.ts), the engines' own build
// (vite.math.ts) and the release check (scripts/math-pack.ts) all read (ADR 0132).
//
// Each engine is a SELF-CONTAINED bundle under `math/<engine>/`, built apart from the app: nothing
// under `math/` imports a file outside `math/`, and the two engines share no file. So the one pack the
// release builds fits every platform's app build, whatever that build's own chunks are called.
//
// The module each entry exports, one `typeset` function, is in engine-contract.ts. This file imports
// nothing, because the root project's release check reads it too.

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
