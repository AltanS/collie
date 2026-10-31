import { headingAnchors, parseInline as parseInlineAny, parseMarkdown as parseMarkdownAny, spansText } from "./markdown";
import { MAX_MATH_CHARS, readDisplayMath, readInlineMath } from "./markdown-math";

// Math is the device's choice and off by default, so every case below asks for it, as MarkdownText
// does when an engine is chosen. The last block pins what Off parses.
const parseInline = (source: string) => parseInlineAny(source, 0, false, undefined, undefined, true);
const parseMarkdown = (source: string) => parseMarkdownAny(source, { math: true });

const text = (value: string) => ({ kind: "text", text: value });
const math = (body: string, source: string) => ({ kind: "math", text: body, source });

describe("inline equations", () => {
  it.each([
    ["$E = mc^2$", "E = mc^2"],
    [String.raw`\(\frac{a_i}{b}\)`, String.raw`\frac{a_i}{b}`],
    [String.raw`$\$5$`, String.raw`\$5`],
    [String.raw`$\$$`, String.raw`\$`],
  ])("keeps the body and source of %s", (source, body) => {
    expect(parseInline(`before ${source} after`)).toEqual([text("before "), math(body, source), text(" after")]);
  });

  it("treats Markdown inside a formula as TeX", () => {
    const body = String.raw`x * y + \text{[label](https://example.com)}`;
    expect(parseInline(`$${body}$`)).toEqual([math(body, `$${body}$`)]);
  });

  it("works inside emphasis, links, lists and quotes", () => {
    expect(parseInline("**$x$**")).toEqual([{ kind: "bold", spans: [math("x", "$x$")] }]);
    expect(parseInline("[$x$](https://example.com)")).toMatchObject([{ kind: "link", spans: [math("x", "$x$")] }]);
    expect(parseMarkdown("- $x$\n\n> \\(y\\)")).toEqual([
      { kind: "list", ordered: false, items: [[math("x", "$x$")]] },
      { kind: "quote", spans: [math("y", String.raw`\(y\)`)] },
    ]);
  });

  it.each([
    ["italic", "*", String.raw`$f^*(x)$`, String.raw`f^*(x)`],
    ["bold", "**", String.raw`$f^{**}(x)$`, String.raw`f^{**}(x)`],
    ["italic", "*", String.raw`\(f^*(x)\)`, String.raw`f^*(x)`],
    ["bold", "**", String.raw`\(f^{**}(x)\)`, String.raw`f^{**}(x)`],
    ["italic", "*", "$a * b$", "a * b"],
  ])("keeps TeX asterisks inside %s equations: %s%s", (kind, marker, source, body) => {
    expect(parseInline(`${marker}${source}${marker}`)).toEqual([{ kind, spans: [math(body, source)] }]);
  });

  it("keeps an emphasized equation intact alongside prose and literal code", () => {
    expect(parseInline("*Optimum $f^*$ and `$literal$`.*")).toEqual([
      { kind: "italic", spans: [text("Optimum "), math("f^*", "$f^*$"), text(" and "), { kind: "code", text: "$literal$" }, text(".")] },
    ]);
  });

  it("preserves equations when emphasis and links wrap each other", () => {
    expect(parseInline("[*$f^*(x)$*](https://example.com)")).toEqual([
      { kind: "link", href: "https://example.com", spans: [{ kind: "italic", spans: [math("f^*(x)", "$f^*(x)$")] }] },
    ]);
    expect(parseInline("**[Optimum $f^{**}$](https://example.com)**")).toEqual([
      { kind: "bold", spans: [{ kind: "link", href: "https://example.com", spans: [text("Optimum "), math("f^{**}", "$f^{**}$")] }] },
    ]);
  });

  it("preserves emphasis around bare URLs and keeps image alt text literal", () => {
    expect(parseInline("**https://example.com**")).toEqual([
      { kind: "bold", spans: [{ kind: "link", href: "https://example.com", spans: [text("https://example.com")] }] },
    ]);
    expect(parseInline("![**$f^{**}$**](plot.png)")).toEqual([text("**$f^{**}$**")]);
  });

  it("preserves emphasized equations in reference link labels", () => {
    const source = "**[Optimum $f^{**}$][ref]**\n\n[ref]: https://example.com";
    expect(parseMarkdown(source)).toEqual([
      { kind: "paragraph", spans: [{ kind: "bold", spans: [
        { kind: "link", href: "https://example.com", spans: [text("Optimum "), math("f^{**}", "$f^{**}$")] },
      ] }] },
    ]);
  });

  it("leaves code and link destinations alone", () => {
    expect(parseInline("`$x$` and `\\(y\\)`")).toEqual([
      { kind: "code", text: "$x$" }, text(" and "), { kind: "code", text: String.raw`\(y\)` },
    ]);
    expect(parseInline("[docs](https://example.com/$x$)")).toMatchObject([{ kind: "link", href: "https://example.com/$x$" }]);
    expect(parseInline("https://example.com/$x$")).toMatchObject([{ kind: "link", href: "https://example.com/$x$" }]);
  });

  it.each(["$5 and $10", "$5.00–$10.00", "$HOME/$USER", "$ x$", "$x $", "$x$10", "$x", String.raw`\(x`, "before $$x$$ after"])(
    "keeps %s as ordinary text", (source) => {
      expect(parseInline(source)).toEqual([text(source)]);
    },
  );

  it("does not let currency steal the next equation", () => {
    expect(parseInline("Costs $5 or $10; compute $2+2$."))
      .toEqual([text("Costs $5 or $10; compute "), math("2+2", "$2+2$"), text(".")]);
  });

  it("honours escaped dollar signs and backslash parity", () => {
    expect(parseInline(String.raw`\$5 and \$10`)).toEqual([text("$5 and $10")]);
    expect(parseInline(String.raw`\$x\$`)).toEqual([text("$x$")]);
    expect(parseInline(String.raw`\\(x\\)`)).toEqual([text(String.raw`\\(x\\)`)]);
    expect(parseInline(String.raw`\\$x$`)).toEqual([text(String.raw`\\`), math("x", "$x$")]);
  });

  it("keeps TeX in heading text and stable anchors", () => {
    expect(spansText(parseInline("About $x^2$"))).toBe("About x^2");
    expect(headingAnchors(parseMarkdown("# About $x^2$"))).toEqual(["about-x2"]);
  });
});

describe("display equations", () => {
  it.each([
    ["$$x^2$$", "x^2"],
    [String.raw`\[x^2\]`, "x^2"],
    ["$$\nx^2\n$$", "x^2"],
    ["\\[\nx^2\n\\]", "x^2"],
  ])("reads %s as one block", (source, body) => {
    expect(parseMarkdown(source)).toEqual([math(body, source)]);
  });

  it("preserves comments, matrix rows and alignment", () => {
    const body = String.raw`\begin{aligned}
x &= 1 \\ % first row
y &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix}
\end{aligned}`;
    const source = `$$\n${body}\n$$`;
    expect(parseMarkdown(source)).toEqual([math(body, source)]);
  });

  it("separates equations from adjacent prose without requiring blank lines", () => {
    expect(parseMarkdown("before\n$$\nx^2\n$$\nafter")).toEqual([
      { kind: "paragraph", spans: [text("before")] },
      math("x^2", "$$\nx^2\n$$"),
      { kind: "paragraph", spans: [text("after")] },
    ]);
  });

  it.each(["$$\nx^2", "\\[\nx^2", "$$\nx^2\n\\]", "$$x$$ trailing", "$$ $$", "$$$$"])(
    "leaves an incomplete or non-block delimiter readable: %s", (source) => {
      expect(parseMarkdown(source).every((block) => block.kind !== "math")).toBe(true);
      expect(readDisplayMath(source.split("\n"), 0)).toBeNull();
    },
  );

  it("does not claim a fenced math example, even after an unmatched opener", () => {
    const source = "```math\n$$\nx^2\n$$\n```";
    expect(parseMarkdown(source)).toEqual([{ kind: "code", lang: "math", text: "$$\nx^2\n$$" }]);
    expect(parseMarkdown(`$$\n${source}`)).toContainEqual({ kind: "code", lang: "math", text: "$$\nx^2\n$$" });
  });

  it("does not collect Markdown reference definitions from equations", () => {
    expect(parseMarkdown("$$\n[ref]: https://example.com\n$$\n\n[ref]")).toEqual([
      math("[ref]: https://example.com", "$$\n[ref]: https://example.com\n$$"),
      { kind: "paragraph", spans: [text("[ref]")] },
    ]);
  });
});

describe("equations in tables", () => {
  it("preserves both absolute-value pipes and escaped norm delimiters", () => {
    const source = String.raw`| $|x|$ | \(\|v\|\) |
| --- | --- |
| $a|b$ | $\|x\|$ |`;
    expect(parseMarkdown(source)).toEqual([{
      kind: "table", source, align: [null, null],
      header: [[math("|x|", "$|x|$")], [math(String.raw`\|v\|`, String.raw`\(\|v\|\)`) ]],
      rows: [[[math("a|b", "$a|b$")], [math(String.raw`\|x\|`, String.raw`$\|x\|$`)]]],
    }]);
  });

  it("does not interpret equations in code cells", () => {
    expect(parseMarkdown("| a | b |\n| --- | --- |\n| `$x` | `y$` |")[0]).toMatchObject({
      rows: [[[{ kind: "code", text: "$x" }], [{ kind: "code", text: "y$" }]]],
    });
  });

  it("ends a table before a display equation containing pipes", () => {
    expect(parseMarkdown("| a |\n| --- |\n| b |\n$$|x|$$").map((block) => block.kind)).toEqual(["table", "math"]);
  });
});

describe("math parsing bounds", () => {
  it("leaves oversized inline and display equations as text", () => {
    const body = "x".repeat(MAX_MATH_CHARS + 1);
    expect(readInlineMath(`$${body}$`, 0)).toBeNull();
    expect(readDisplayMath(["$$", body, "$$"], 0)).toBeNull();
  });

  it("bounds lookahead for many unmatched display openers", () => {
    const source = "\\[\nx\n".repeat(20_000);
    const start = performance.now();
    expect(parseMarkdown(source).some((block) => block.kind === "math")).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("does not rescan a long backslash run at every character", () => {
    const source = "\\".repeat(100_000);
    const start = performance.now();
    expect(parseInline(source)).toEqual([text(source)]);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("keeps large literal table cells bounded too", () => {
    const source = `| a |\n| --- |\n| ${"\\".repeat(100_000)}${"`".repeat(100_000)} |`;
    const start = performance.now();
    expect(parseMarkdown(source)[0]?.kind).toBe("table");
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("with math off (the default)", () => {
  it("reads every delimiter as the text it was before math existed", () => {
    for (const source of ["$E = mc^2$", String.raw`\(x\)`, String.raw`price \$5`, "$5 and $10"]) {
      expect(parseMarkdownAny(source)).toEqual([{ kind: "paragraph", spans: [text(source)] }]);
    }
  });

  it("leaves display delimiters to the paragraph", () => {
    expect(parseMarkdownAny("$$\nx^2\n$$")).toEqual([{ kind: "paragraph", spans: [text("$$ x^2 $$")] }]);
    expect(parseMarkdownAny("$$\nx^2\n$$", { math: false })).toEqual(parseMarkdownAny("$$\nx^2\n$$"));
  });

  it("still splits a table cell at a pipe inside an equation", () => {
    const [table] = parseMarkdownAny("| a | b |\n| - | - |\n| $|x|$ | y |");
    expect(table).toMatchObject({ kind: "table" });
    expect(parseMarkdownAny("| a | b |\n| - | - |\n| $|x|$ | y |")).not.toEqual(
      parseMarkdownAny("| a | b |\n| - | - |\n| $|x|$ | y |", { math: true }),
    );
  });
});
