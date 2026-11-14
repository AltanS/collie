import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

import { copyText } from "@/lib/clipboard";
import { setDesignMath, type MathEngine } from "@/lib/design";
import { MAX_MATH_CHARS } from "@/lib/markdown-math";
import { __setMathEngineImport, loadMathEngine } from "@/lib/math/engine";
import { fixtureMathMarkdown } from "@/test/math-fixtures";

import { MarkdownText, StretchTextContext } from "./markdown-text";
import { MathText } from "./math-text";

vi.mock("@/lib/clipboard", () => ({ canCopyText: () => true, copyText: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));

// jsdom cannot `import()` the host's `math/<engine>/<engine>.js`, so the engines come from their
// source modules, the entries of those bundles (web/vite.math.ts).
__setMathEngineImport((engine) => (engine === "katex" ? import("@/lib/math/katex") : import("@/lib/math/mathjax")));

/** The device chose `engine`, and it has loaded, as main.tsx's startup load leaves it. */
function useEngine(engine: MathEngine) {
  beforeEach(async () => {
    setDesignMath(engine);
    await loadMathEngine(engine);
  });
  // Unmount first: switching the store back with formulas still mounted would re-render them outside
  // act(), after Testing Library's own cleanup no longer covers them.
  afterEach(() => {
    cleanup();
    setDesignMath("off");
  });
}

describe("Markdown equations with math off (the default)", () => {
  it("draws every delimiter as text and loads no engine", () => {
    const { container } = render(<MarkdownText text={fixtureMathMarkdown} />);
    expect(within(container).queryByRole("math")).toBeNull();
    expect(container.querySelector('[data-slot="math"]')).toBeNull();
    expect(container.textContent).toContain("$$");
    expect(container.textContent).toContain("Prices remain $5 and $10.");
  });
});

describe("Markdown equations with KaTeX", () => {
  useEngine("katex");

  it("renders the document used by the browser checks", () => {
    const { container } = render(<MarkdownText text={fixtureMathMarkdown} />);
    expect(container.querySelectorAll("math")).toHaveLength(5);
    expect(container.querySelector("mtable")).not.toBeNull();
  });

  it.each(["chat", "document"] as const)("renders accessible inline and display math in %s", (variant) => {
    const { container } = render(<MarkdownText text={"Inline $x^2$.\n\n$$\n\\frac{a}{b}\n$$"} variant={variant} />);
    // jsdom cannot compute MathML styles. Assert its tree here; real browser tests cover visibility.
    expect(within(container).getAllByRole("math", { hidden: true })).toHaveLength(2);
    expect(container.querySelectorAll("annotation")[0]?.textContent).toBe("x^2");
    expect(container.querySelectorAll("annotation")[1]?.textContent).toBe(String.raw`\frac{a}{b}`);
    expect(container.querySelector('math[display="block"]')).not.toBeNull();
    expect(container.querySelector("math")?.namespaceURI).toBe("http://www.w3.org/1998/Math/MathML");
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it.each([
    ["em", "*$f^*(x)$*", "f^*(x)"],
    ["strong", "**$f^{**}(x)$**", "f^{**}(x)"],
  ])("renders the complete equation inside %s", (tag, source, body) => {
    const { container } = render(<MarkdownText text={source} />);
    expect(within(container).getAllByRole("math", { hidden: true })).toHaveLength(1);
    expect(container.querySelector(`${tag} math annotation`)?.textContent).toBe(body);
  });

  it("keeps incomplete streamed delimiters visible until the expression closes", () => {
    const { container, rerender } = render(<MarkdownText text="Energy $E = mc^2" />);
    expect(container.textContent).toBe("Energy $E = mc^2");
    expect(within(container).queryByRole("math")).toBeNull();
    rerender(<MarkdownText text="Energy $E = mc^2$" />);
    expect(within(container).getByRole("math", { hidden: true }).isConnected).toBe(true);
  });

  it.each([String.raw`$\frac{$`, String.raw`$\unknowncommand{x}$`, String.raw`$\def\a{\a}\a$`])(
    "falls back to the source on invalid or excessive TeX: %s", (source) => {
      const { container } = render(<MarkdownText text={source} />);
      expect(container.textContent).toBe(source);
      expect(within(container).queryByRole("math")).toBeNull();
    },
  );

  it("enforces the rendering bound even when called without the Markdown parser", () => {
    const text = "x".repeat(MAX_MATH_CHARS + 1);
    const source = `$${text}$`;
    const { container } = render(<MathText text={text} source={source} />);
    expect(container.textContent).toBe(source);
    expect(within(container).queryByRole("math")).toBeNull();
  });

  it("does not share macro definitions between equations", () => {
    const { container } = render(<MarkdownText text={String.raw`$\gdef\myvalue{42}\myvalue$ and $\myvalue$`} />);
    expect(within(container).getAllByRole("math", { hidden: true })).toHaveLength(1);
    expect(container.textContent).toContain(String.raw`$\myvalue$`);
  });

  it.each([
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\includegraphics{https://example.com/track.png}`,
    String.raw`\htmlStyle{background:url(https://example.com/track)}{x}`,
    String.raw`\htmlClass{injected}{x}`,
    String.raw`\text{<img src=x onerror=alert(1)>}`,
    String.raw`\unknown{<script>alert(1)</script>}`,
  ])("does not turn %s into active HTML or a resource request", (body) => {
    const { container } = render(<MarkdownText text={`$${body}$`} />);
    expect(container.querySelector("a, img, script, iframe, style, [onerror], [onclick], .injected")).toBeNull();
    for (const element of container.querySelectorAll("[style]")) {
      expect(element.getAttribute("style")).not.toContain("url(");
    }
  });

  it("draws $$...$$ in a list item as display math", () => {
    const { container } = render(<MarkdownText text="- $$E = mc^2$$" />);
    expect(container.querySelector("li .math-display .katex-display")).not.toBeNull();
  });

  it("keeps a formula's braces as TeX when stretchtext is on", () => {
    const { container } = render(
      <StretchTextContext.Provider value>
        <MarkdownText text={String.raw`Let $x^{{2n}}$ grow.`} stretches />
      </StretchTextContext.Provider>,
    );
    expect(within(container).getByRole("math", { hidden: true }).textContent).toContain("x^{{2n}}");
  });

  it("keeps raw HTML and fenced equations literal", () => {
    const { container } = render(<MarkdownText text={'<img src=x onerror="alert(1)">\n\n```latex\n$$x^2$$\n```\n\n`$x$`'} />);
    expect(container.querySelector("img, math")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe("$$x^2$$");
    expect(container.querySelector("code")?.textContent).toBe("$x$");
  });

  it("copies the display equation's exact source, including delimiters", async () => {
    const source = "\\[\n\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}\n\\]";
    const { container } = render(<MarkdownText text={source} />);
    fireEvent.click(within(container).getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(source));
  });

  it("marks a source search hit without putting marks inside the formula", () => {
    const { container, rerender } = render(<MarkdownText text={String.raw`$\frac{a}{b}$`} query="FRAC" />);
    expect(container.querySelector("mark math")).not.toBeNull();
    expect(container.querySelector("math mark")).toBeNull();
    rerender(<MarkdownText text={String.raw`$\frac{a}{b}$`} query="missing" />);
    expect(container.querySelector("mark")).toBeNull();
    expect(within(container).getByRole("math", { hidden: true }).isConnected).toBe(true);
  });
});

describe("Markdown equations with MathJax", () => {
  useEngine("mathjax");

  it("renders inline and display math as labelled SVG", () => {
    const { container } = render(<MarkdownText text={"Inline $x^2$.\n\n$$\n\\frac{a}{b}\n$$"} />);
    const formulas = within(container).getAllByRole("math");
    expect(formulas.map((node) => node.getAttribute("aria-label"))).toEqual(["x^2", String.raw`\frac{a}{b}`]);
    for (const node of formulas) expect(node.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('mjx-container[display="true"]')).not.toBeNull();
  });

  it("loads a font range on demand, showing the source until it arrives", async () => {
    const source = String.raw`$\mathfrak{g}$`;
    const { container } = render(<MarkdownText text={source} />);
    expect(container.textContent).toBe(source);
    expect(await within(container).findByRole("math")).toHaveAttribute("aria-label", String.raw`\mathfrak{g}`);
  });

  it.each([String.raw`$\frac{$`, String.raw`$\unknowncommand{x}$`, String.raw`$\def\a{1}\a$`, String.raw`$\newcommand{\a}{1}\a$`])(
    "falls back to the source on TeX it does not typeset: %s",
    (source) => {
      const { container } = render(<MarkdownText text={source} />);
      expect(container.textContent).toBe(source);
      expect(within(container).queryByRole("math")).toBeNull();
    },
  );

  it.each([
    String.raw`\href{javascript:alert(1)}{click}`,
    String.raw`\class{injected}{x}`,
    String.raw`\style{background:url(https://example.com/track)}{x}`,
    String.raw`\cssId{injected}{x}`,
    String.raw`\unicode{x41}`,
    String.raw`\require{html}`,
    String.raw`\text{<img src=x onerror=alert(1)>}`,
  ])("does not turn %s into active HTML or a resource request", (body) => {
    const { container } = render(<MarkdownText text={`$${body}$`} />);
    expect(container.querySelector("a, img, script, iframe, style, use, [onerror], [onclick], .injected, #injected")).toBeNull();
    for (const element of container.querySelectorAll("[style]")) {
      expect(element.getAttribute("style")).not.toContain("url(");
    }
  });

  // base's `\mmlToken{kind}[attributes]{text}` accepts href, style, class and id. The formula still
  // draws, but none of the four reaches the page: a link of any scheme there would skip the Markdown
  // link rule (http, https and mailto only, in a new tab).
  it.each([
    String.raw`\mmlToken{mi}[href="https://example.com/landed"]{x}`,
    String.raw`\mmlToken{mo}[href="intent://scan/#Intent;scheme=zxing;end"]{=}`,
    String.raw`\mmlToken{mi}[href="javascript:alert(1)"]{y}`,
    String.raw`\mmlToken{mi}[style="background-image:url(https://example.com/beacon.png)"]{z}`,
    String.raw`\mmlToken{mi}[class="injected"]{x}`,
    String.raw`\mmlToken{mi}[id="injected"]{x}`,
  ])("draws %s without its link, style, class or id", (body) => {
    const { container } = render(<MarkdownText text={`$${body}$`} />);
    expect(within(container).getByRole("math")).toHaveAttribute("aria-label", body);
    expect(container.querySelector("a, [href], [*|href], .injected, #injected")).toBeNull();
    for (const element of container.querySelectorAll("[style]")) {
      expect(element.getAttribute("style")).not.toContain("url(");
    }
  });

  // An mglyph's `src` would draw an `<image>` that fetches the URL. Without it the glyph has nothing to
  // draw, so the formula shows its source.
  it.each([
    String.raw`\mmlToken{mglyph}[src="https://example.com/beacon.png" alt="g"]{}`,
    String.raw`\mmlToken{mglyph}[src="https://example.com/beacon.png" width="1em" height="1em"]{}`,
  ])("does not draw %s as an image", (body) => {
    const { container } = render(<MarkdownText text={`$${body}$`} />);
    expect(container.querySelector("image, img, [src], [href], [*|href]")).toBeNull();
  });

  // `\color`, `\colorbox`, `mathcolor`, `mathbackground` and `\cancel`'s options take any string, and
  // the SVG output writes it as a paint: `fill="url(...)"` names a resource or a page element. The
  // formula draws in the theme colour instead. `data-latex` and the label quote the TeX, as text.
  it.each([
    String.raw`\color{url(https://example.com/paint.svg#p)}{x}`,
    String.raw`\colorbox{url(#elsewhere)}{x}`,
    String.raw`\mmlToken{mi}[mathcolor="url(#elsewhere)"]{x}`,
    String.raw`\mmlToken{mi}[mathbackground="url(#elsewhere)"]{x}`,
    String.raw`\cancel[mathbackground=url(#elsewhere)]{x}`,
  ])("draws %s without a url() paint", (body) => {
    const { container } = render(<MarkdownText text={`$${body}$`} />);
    expect(within(container).getByRole("math")).toHaveAttribute("aria-label", body);
    for (const element of container.querySelectorAll("svg, svg *")) {
      for (const { name, value } of element.attributes) {
        if (!/^(data|aria)-/.test(name)) expect(value).not.toContain("url(");
      }
    }
  });

  it("keeps the colour a formula asks for", () => {
    const { container } = render(<MarkdownText text={String.raw`$\color{red}{x}$`} />);
    expect(container.querySelector('[fill="red"]')).not.toBeNull();
  });

  // mathtools declares macros on the TeX input it runs in. Each formula gets its own, so a
  // declaration never reaches a later formula, and the same declaration in two formulas works twice.
  it("does not share a mathtools declaration between equations", () => {
    const declare = String.raw`\DeclarePairedDelimiter{\norm}{\lVert}{\rVert}`;
    const text = String.raw`$${declare}\norm{a}$ then $\norm{b}$ and $${declare}\norm{c}$`;
    const { container } = render(<MarkdownText text={text} />);
    expect(within(container).getAllByRole("math").map((node) => node.getAttribute("aria-label"))).toEqual([
      String.raw`${declare}\norm{a}`,
      String.raw`${declare}\norm{c}`,
    ]);
    expect(container.textContent).toContain(String.raw`$\norm{b}$`);
  });

  it("keeps a wide equation within its own scroller", () => {
    const { container } = render(<MarkdownText text={"$$\n" + Array.from({ length: 40 }, (_, i) => `x_{${i}}`).join(" + ") + "\n$$"} />);
    expect(container.querySelector('.math-display mjx-container[display="true"]')).not.toBeNull();
  });
});
