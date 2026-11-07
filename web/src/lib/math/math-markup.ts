import { fromHtml } from "hast-util-from-html";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

/**
 * An engine's generated markup as React elements and text nodes. Only KaTeX's or MathJax's own
 * output reaches this parser, never Markdown or user HTML, and both engines run with their URL,
 * HTML and macro-definition extensions off (katex.ts, mathjax.ts). There is no DOM HTML sink here:
 * the tree becomes `jsx()` calls, so React escapes every text node and sets every `style` through
 * the CSSOM, which the bridge's CSP allows.
 */
export function markupToReact(markup: string): ReactNode {
  return toJsxRuntime(fromHtml(markup, { fragment: true }), { Fragment, jsx, jsxs });
}
