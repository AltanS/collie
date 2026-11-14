import type { Root } from "hast";
import { render } from "@testing-library/react";

import { markupToReact } from "./math-markup";

// The sink's own wall, fed a tree no engine makes today: whatever an engine lets through, a formula
// draws and does nothing else (issue 773).
const hostile: Root = {
  type: "root",
  children: [
    {
      type: "element",
      tagName: "span",
      properties: { className: ["katex"], style: "height:1em", ariaLabel: String.raw`\color{url(#a)}{x}` },
      children: [
        {
          type: "element",
          tagName: "svg",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "a",
              properties: { href: "javascript:alert(1)" },
              children: [{ type: "element", tagName: "path", properties: { d: "M0 0", dataC: "78" }, children: [] }],
            },
            { type: "element", tagName: "image", properties: { href: "https://example.com/beacon.png" }, children: [] },
            { type: "element", tagName: "use", properties: { xLinkHref: "#elsewhere" }, children: [] },
            { type: "element", tagName: "set", properties: { attributeName: "href", to: "javascript:" }, children: [] },
            { type: "element", tagName: "foreignObject", properties: {}, children: [] },
            {
              type: "element",
              tagName: "g",
              properties: { id: "injected", onClick: "alert(1)", fill: "url(#elsewhere)", stroke: "red" },
              children: [{ type: "element", tagName: "rect", properties: { style: "background:url(https://example.com/t)" }, children: [] }],
            },
          ],
        },
      ],
    },
  ],
};

describe("markupToReact", () => {
  it("keeps the drawing and drops every link, resource, handler and page id", () => {
    const { container } = render(<>{markupToReact(hostile)}</>);
    expect(container.querySelector("a, image, use, set, foreignObject, [href], [*|href], [src], #injected, [onclick]")).toBeNull();
    for (const element of container.querySelectorAll("*")) {
      for (const { name, value } of element.attributes) {
        if (name !== "aria-label") expect(value).not.toMatch(/url\(|javascript:/);
      }
    }
    // The drawing, its colour, KaTeX's class and size, and the label stay.
    expect(container.querySelector('svg path[d="M0 0"]')).not.toBeNull();
    expect(container.querySelector('g[stroke="red"] rect')).not.toBeNull();
    const span = container.querySelector("span.katex");
    expect(span).toHaveStyle({ height: "1em" });
    expect(span).toHaveAttribute("aria-label", String.raw`\color{url(#a)}{x}`);
  });
});
