import type { ElementContent, Properties, Root, RootContent } from "hast";
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
  return toJsxRuntime(scrubRoot(tree), { Fragment, jsx, jsxs });
}

// A FORMULA DRAWS AND DOES NOTHING ELSE, whatever the engine let through. The engines' own filters
// (katex.ts `trust: false`, mathjax.ts `dropPageAttributes`) shut the TeX side; this is the second
// wall, at the sink, for a door neither of them knows about (issue 773: MathJax's `\mmlToken` made an
// `<a href>` of any scheme). No link, no resource and no script survive it: an `<a>` keeps only its
// drawing, an element that fetches or runs something is dropped with its content, and so is any
// attribute that names a URL, an event handler or a page id. A paint value of `url(...)` (`\color`,
// `\colorbox` and `mathcolor` take any string) goes too, so the glyph falls back to the theme colour.
// Class and style stay: KaTeX's layout is classes and inline sizes.
const UNWRAPPED = new Set(["a"]);
const DROPPED = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "base",
  "button",
  "embed",
  "feimage",
  "foreignobject",
  "form",
  "iframe",
  "image",
  "img",
  "input",
  "link",
  "meta",
  "object",
  "script",
  "set",
  "style",
  "use",
  "video",
]);
const DROPPED_PROPERTIES = new Set(["href", "xLinkHref", "src", "srcSet", "action", "formAction", "id", "ping"]);
const URL_VALUE = /url\s*\(|javascript:|vbscript:/i;
// Text the page never follows: the formula's TeX as its label (`aria-label`, MathJax's `data-latex`).
const TEXT_PROPERTY = /^(aria|data)[A-Z]|^(alt|title)$/;

function scrubRoot(tree: Root): Root {
  return { ...tree, children: tree.children.flatMap(scrub) };
}

function scrub(node: RootContent): ElementContent[] {
  if (node.type === "doctype") return [];
  if (node.type !== "element") return [node];
  const name = node.tagName.toLowerCase();
  if (DROPPED.has(name)) return [];
  const children = node.children.flatMap(scrub);
  if (UNWRAPPED.has(name)) return children;
  return [{ ...node, properties: scrubProperties(node.properties), children }];
}

function scrubProperties(properties: Properties): Properties {
  const kept: Properties = {};
  for (const [name, value] of Object.entries(properties)) {
    if (DROPPED_PROPERTIES.has(name) || /^on/i.test(name)) continue;
    if (!TEXT_PROPERTY.test(name) && URL_VALUE.test(Array.isArray(value) ? value.join(" ") : String(value))) continue;
    kept[name] = value;
  }
  return kept;
}
