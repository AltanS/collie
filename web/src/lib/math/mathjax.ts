import type { LiteDocument } from "@mathjax/src/js/adaptors/lite/Document.js";
import type { LiteElement } from "@mathjax/src/js/adaptors/lite/Element.js";
import type { LiteText } from "@mathjax/src/js/adaptors/lite/Text.js";
import { liteAdaptor } from "@mathjax/src/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "@mathjax/src/js/handlers/html.js";
import { TeX } from "@mathjax/src/js/input/tex.js";
import "@mathjax/src/js/input/tex/ams/AmsConfiguration.js";
import "@mathjax/src/js/input/tex/base/BaseConfiguration.js";
import "@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import "@mathjax/src/js/input/tex/braket/BraketConfiguration.js";
import "@mathjax/src/js/input/tex/cancel/CancelConfiguration.js";
import "@mathjax/src/js/input/tex/color/ColorConfiguration.js";
import "@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js";
import type TexError from "@mathjax/src/js/input/tex/TexError.js";
import { mathjax } from "@mathjax/src/js/mathjax.js";
import { SVG } from "@mathjax/src/js/output/svg.js";
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";
import { createElement } from "react";

import { MAX_MATH_CHARS } from "@/lib/markdown-math";

import type { MathRenderer, Typeset } from "./engine";
import { markupToReact } from "./math-markup";
import "./mathjax.css";

// MathJax 4: TeX in, SVG out, run in the page on MathJax's own DOM-free adaptor (liteAdaptor), so it
// never touches the document. SVG rather than CHTML because the glyphs are paths: no web font to
// fetch, nothing for the CSP's font-src to refuse, and `currentColor` follows the theme.
// `fontCache: "none"` makes each formula self-contained, with no `<use href>` into a shared <defs>
// that a later message would depend on.
//
// THE PACKAGES ARE AN ALLOWLIST. base and ams are what agents write; boldsymbol, braket, cancel,
// color and mathtools are common and inert. Deliberately absent: `newcommand` (\def, \newcommand —
// a definition in one message must not change a later one), `html` (\class, \style, \cssId),
// `unicode`, `require` and `autoload` (which would load the rest on demand), and `noerrors` /
// `noundefined`, so a formula that does not parse THROWS and the caller shows its source.
//
// FONT RANGES load on demand. The base font is in this chunk; `\mathbb`, `\mathfrak` and friends live
// in ranges MathJax asks for through `mathjax.asyncLoad`. Each is a lazy chunk of its own (the glob
// below), so a device fetches only the ranges its formulas use.

const FONT_RANGES = import.meta.glob("../../../node_modules/@mathjax/mathjax-newcm-font/mjs/svg/dynamic/*.js");

/** Load the range MathJax names, found by its file name: the specifier's spelling varies. */
async function loadRange(name: string): Promise<void> {
  const file = name.slice(name.lastIndexOf("/") + 1);
  for (const [path, load] of Object.entries(FONT_RANGES)) {
    if (path.endsWith(`/${file}`)) {
      await load();
      return;
    }
  }
  throw new Error(`no MathJax font range ${file}`);
}

// A FRESH TeX INPUT FOR EVERY FORMULA, so nothing one formula defines reaches another. mathtools
// keeps state on the input: `\DeclarePairedDelimiter` adds a macro (and the same declaration a
// second time then fails as already defined), `\newtagform` adds a tag format and `\mathtoolsset`
// changes its options. A new input costs about 0.1 ms; the SVG output and its font data are shared,
// which is where the cost of a document lies.
const texInput = (): TeX<LiteElement, LiteText, LiteDocument> =>
  new TeX({
    packages: ["base", "ams", "boldsymbol", "braket", "cancel", "color", "mathtools"],
    // Throw instead of drawing a red error box: the caller's fallback is the source, as text.
    formatError: (_jax: TeX<LiteElement, LiteText, LiteDocument>, err: TexError) => {
      throw err;
    },
  });

export function mathjaxRenderer(): MathRenderer {
  mathjax.asyncLoad = loadRange;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  // No automatic line breaking: MathJax 4 would break a long inline formula into a column of
  // pieces. A wide formula pans inside its own scroller instead (`.math-inline`, `.math-display` in
  // index.css), the same as KaTeX's.
  const svg = new SVG({ fontCache: "none", fontData: MathJaxNewcmFont, linebreaks: { inline: false } });

  // The SVG is decorative to a screen reader; the wrapper reads as math, labelled with its TeX.
  const toReact = (text: string, node: LiteElement): Typeset =>
    createElement(
      "span",
      { role: "math", "aria-label": text },
      markupToReact(adaptor.outerHTML(node).replace("<svg ", '<svg aria-hidden="true" ')),
    );
  // `convert` is typed `any` upstream; with this document's adaptor it is a LiteElement.
  const convert = (text: string, display: boolean): LiteElement =>
    mathjax.document("", { InputJax: texInput(), OutputJax: svg }).convert(text, { display });

  return {
    render(text, display) {
      if (text.length > MAX_MATH_CHARS) return null;
      try {
        return toReact(text, convert(text, display));
      } catch (err) {
        // MathJax's "a font range is still loading" error carries a `retry` promise; anything else
        // is TeX that does not typeset.
        if (!(err instanceof Error && "retry" in err)) return null;
        return mathjax
          .handleRetriesFor(() => convert(text, display))
          .then((node: LiteElement) => toReact(text, node))
          .catch(() => null);
      }
    },
  };
}
