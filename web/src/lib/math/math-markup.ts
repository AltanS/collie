import type { Root } from "hast";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

/**
 * An engine's typeset formula, a hast tree (engine-contract.ts), as React elements and text nodes. Only
 * KaTeX's or MathJax's own output reaches the engines' parser, never Markdown or user HTML, and both
 * run with their URL, HTML and macro-definition extensions off (katex.ts, mathjax.ts). There is no
 * DOM HTML sink here: the tree becomes `jsx()` calls, so React escapes every text node and sets every
 * `style` through the CSSOM, which the bridge's CSP allows.
 */
export function markupToReact(tree: Root): ReactNode {
  return toJsxRuntime(tree, { Fragment, jsx, jsxs });
}
