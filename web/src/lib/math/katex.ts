import { renderToString } from "katex";
import "katex/dist/katex.min.css";

import "./katex.css";

import { MAX_MATH_CHARS } from "@/lib/markdown-math";

import type { MathRenderer, Typeset } from "./engine";
import { markupToReact } from "./math-markup";

// KaTeX: small, synchronous, its own web fonts. The stylesheet comes with this module, so it lands
// in the lazy `math/` chunk and a device on Off never downloads it. Its fonts are same-origin files
// (vite.config.ts keeps them out of `data:` URIs, which the CSP refuses).

function typeset(text: string, display: boolean): Typeset {
  if (text.length > MAX_MATH_CHARS) return null;
  try {
    const markup = renderToString(text, {
      displayMode: display,
      // MathML is the accessible reading; the HTML half is aria-hidden by KaTeX itself.
      output: "htmlAndMathml",
      // No \href, \url, \includegraphics or \htmlClass.
      trust: false,
      throwOnError: true,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
      // A definition in one equation must not change a later message's meaning.
      macros: {},
    });
    return markupToReact(markup);
  } catch {
    // An error's message may quote the input. The caller shows the source through React instead.
    return null;
  }
}

export const katexRenderer: MathRenderer = { render: typeset };
