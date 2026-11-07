import { fromHtml } from "hast-util-from-html";
import { renderToString } from "katex";
import "katex/dist/katex.min.css";

import "./katex.css";

import type { MathEngineModule, MathMarkup } from "./engine-files";

// KaTeX: small, synchronous, its own web fonts. THIS FILE IS THE ENTRY OF A BUNDLE OF ITS OWN,
// `math/katex/katex.js` (vite.math.ts), never a module of the app: the app loads it by URL and calls
// `typeset` (the contract is in engine-files.ts). Its stylesheet lands beside it as `katex.css`, and
// its fonts are same-origin files there (vite.math.ts keeps them out of `data:` URIs, which the CSP
// refuses).
//
// The markup is parsed into a hast tree here, so the parser stays in the engine's bundle; only KaTeX's
// own output reaches it, never Markdown or user HTML, and KaTeX runs with its URL, HTML and
// macro-definition extensions off. The app turns the tree into React elements (math-markup.ts).

export const typeset: MathEngineModule["typeset"] = (text, display): MathMarkup => {
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
    return fromHtml(markup, { fragment: true });
  } catch {
    // An error's message may quote the input. The caller shows the source through React instead.
    return null;
  }
};
