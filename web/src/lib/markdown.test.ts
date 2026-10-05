import {
  classifyHref,
  headingAnchors,
  headingSlug,
  parseInline,
  parseMarkdown,
  type MdSpan,
} from "./markdown";

// The Markdown grammar for transcript prose. It exists because agent output IS Markdown and reading
// `## Heading` / `**bold**` raw on a phone is worse than reading it formatted — but it must never
// produce markup, only an AST the renderer turns into React elements (the repo's XSS boundary).
//
// The two deliberate omissions below (underscore emphasis, space-flanked asterisks) are the ones
// that matter for CODE-HEAVY text, which is what agents actually emit.

describe("classifyHref", () => {
  it.each([
    ["https", "https://example.com"],
    ["http", "http://example.com"],
    ["mailto", "mailto:a@b.com"],
  ])("%s is external", (_label, href) => {
    expect(classifyHref(href)).toEqual({ href, rel: false });
  });

  // Not a web address: the parser keeps it, flagged, and the screen decides where it leads.
  it.each([
    ["a rooted path", "/pane/w1:p1"],
    ["a fragment", "#section"],
    ["a dot-relative path", "./other.md"],
    ["a parent path", "../x.md"],
    ["a bare path", "docs/x.md"],
    ["a bare file name", "other.md"],
    ["a path with a colon after a slash", "docs/a:b.md"],
  ])("%s is relative", (_label, href) => {
    expect(classifyHref(href)).toEqual({ href, rel: true });
  });

  // A link is the one place this view could hand a URL straight to the browser.
  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["JaVaScRiPt: (case dodge)", "JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["file:", "file:///etc/passwd"],
    ["a made-up scheme", "foo-bar+baz.1:thing"],
    ["a protocol-relative host", "//evil.example/x"],
    ["a protocol-relative host with a backslash", "/\\evil.example/x"],
    ["a leading backslash", "\\\\host\\share"],
    ["a control character inside a scheme", "java\x01script:alert(1)"],
    ["a tab inside a scheme", "java\tscript:alert(1)"],
    ["empty", "   "],
  ])("refuses %s", (_label, href) => {
    expect(classifyHref(href)).toBeNull();
  });
});

describe("parseInline", () => {
  it("plain text is a single span", () => {
    expect(parseInline("just words")).toEqual([{ kind: "text", text: "just words" }]);
  });

  it.each([
    ["bold", "a **strong** b", { kind: "bold", spans: [{ kind: "text", text: "strong" }] }],
    ["italic", "a *soft* b", { kind: "italic", spans: [{ kind: "text", text: "soft" }] }],
    ["code", "a `x = 1` b", { kind: "code", text: "x = 1" }],
  ])("parses %s between text runs", (_label, src, mid) => {
    expect(parseInline(src)).toEqual([
      { kind: "text", text: "a " },
      mid,
      { kind: "text", text: " b" },
    ]);
  });

  it("bold wins over italic on a double delimiter", () => {
    expect(parseInline("**both**")).toEqual([
      { kind: "bold", spans: [{ kind: "text", text: "both" }] },
    ]);
  });

  // Regression: agents write **`sha`** constantly. A flat span model rendered those backticks
  // literally, right next to correctly-chipped neighbours — so emphasis bodies are re-parsed.
  it("parses inline code nested inside bold", () => {
    expect(parseInline("**`c6fe96`**")).toEqual([
      { kind: "bold", spans: [{ kind: "code", text: "c6fe96" }] },
    ]);
  });

  it("parses mixed content inside emphasis", () => {
    expect(parseInline("**ship `a.ts` now**")).toEqual([
      {
        kind: "bold",
        spans: [
          { kind: "text", text: "ship " },
          { kind: "code", text: "a.ts" },
          { kind: "text", text: " now" },
        ],
      },
    ]);
  });

  it("parses emphasis inside a link label", () => {
    expect(parseInline("[**docs**](https://example.com)")).toEqual([
      {
        kind: "link",
        href: "https://example.com",
        spans: [{ kind: "bold", spans: [{ kind: "text", text: "docs" }] }],
      },
    ]);
  });

  it("terminates on pathological nesting instead of recursing without bound", () => {
    expect(() => parseInline("*".repeat(200) + "x" + "*".repeat(200))).not.toThrow();
  });

  it("does not treat snake_case as emphasis — underscore emphasis is unsupported on purpose", () => {
    const src = "see betting_tip_prose_consistency and __dunder__ names";
    expect(parseInline(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("does not swallow a shell glob into an italic run", () => {
    // The space before the closing marker disqualifies it — otherwise "*.ts to *" became italic.
    const src = "rename *.ts to *.tsx";
    expect(parseInline(src)).toEqual([{ kind: "text", text: src }]);
  });

  it("keeps code content literal — markdown inside backticks is not parsed", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
  });

  it("parses a safe link", () => {
    expect(parseInline("see [docs](https://example.com) now")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", href: "https://example.com", spans: [{ kind: "text", text: "docs" }] },
      { kind: "text", text: " now" },
    ]);
  });

  it("an unsafe link shows its label and never its source or its address", () => {
    expect(parseInline("[click](javascript:alert(1))")).toEqual([{ kind: "text", text: "click" }]);
  });

  it("links a bare URL an agent wrote as itself", () => {
    expect(parseInline("live on http://bluefin:8788 now")).toEqual([
      { kind: "text", text: "live on " },
      { kind: "link", href: "http://bluefin:8788", spans: [{ kind: "text", text: "http://bluefin:8788" }] },
      { kind: "text", text: " now" },
    ]);
  });

  it("a bare URL gives back the sentence punctuation it ended on", () => {
    const spans = parseInline("see https://example.com/a?x=1.");
    expect(spans[1]).toEqual({
      kind: "link",
      href: "https://example.com/a?x=1",
      spans: [{ kind: "text", text: "https://example.com/a?x=1" }],
    });
    expect(spans[2]).toEqual({ kind: "text", text: "." });
  });

  it("a URL inside a code span stays code", () => {
    expect(parseInline("`http://in-code:1`")).toEqual([{ kind: "code", text: "http://in-code:1" }]);
  });

  it("a URL used as a link's own label does not nest a second link", () => {
    expect(parseInline("[https://a.example](https://b.example)")).toEqual([
      {
        kind: "link",
        href: "https://b.example",
        spans: [{ kind: "text", text: "https://a.example" }],
      },
    ]);
  });

  it("a scheme glued to a word is not a URL", () => {
    expect(parseInline("xhttp://nope.example")).toEqual([{ kind: "text", text: "xhttp://nope.example" }]);
  });

  it("leaves HTML-looking text as text — there is no markup path at all", () => {
    const src = '<img src=x onerror="alert(1)">';
    expect(parseInline(src)).toEqual([{ kind: "text", text: src }]);
  });
});

describe("parseMarkdown", () => {
  it("parses headings by level", () => {
    expect(parseMarkdown("## Two\n### Three")).toEqual([
      { kind: "heading", level: 2, spans: [{ kind: "text", text: "Two" }] },
      { kind: "heading", level: 3, spans: [{ kind: "text", text: "Three" }] },
    ]);
  });

  it("reflows a hard-wrapped paragraph instead of keeping source line breaks", () => {
    // The phone's width should decide the wrapping, not the agent's 100-column source.
    expect(parseMarkdown("one two\nthree four")).toEqual([
      { kind: "paragraph", spans: [{ kind: "text", text: "one two three four" }] },
    ]);
  });

  it("blank lines separate paragraphs", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
  });

  it("keeps fenced code verbatim, with its language", () => {
    const src = "```ts\nconst a = 1;\n\n// **not bold**\n```";
    expect(parseMarkdown(src)).toEqual([
      { kind: "code", lang: "ts", text: "const a = 1;\n\n// **not bold**" },
    ]);
  });

  it("an unterminated fence still yields a code block rather than eating the rest as prose", () => {
    expect(parseMarkdown("```\nno closing fence")).toEqual([
      { kind: "code", lang: "", text: "no closing fence" },
    ]);
  });

  it("parses bullet and numbered lists", () => {
    expect(parseMarkdown("- one\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]],
      },
    ]);
    const ol = parseMarkdown("1. first\n2. second");
    expect(ol[0]).toMatchObject({ kind: "list", ordered: true });
    // SAFETY: the line above pinned `ol[0]` as an ordered list block, and a list block carries
    // `items`. The Block union is addressed positionally here, which is what needs writing down.
    expect((ol[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it("switching marker kind starts a new list, not one mixed block", () => {
    const blocks = parseMarkdown("- bullet\n1. numbered");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ ordered: false });
    expect(blocks[1]).toMatchObject({ ordered: true });
  });

  it("reads a rule as a rule, not a bullet", () => {
    expect(parseMarkdown("---")).toEqual([{ kind: "rule" }]);
  });

  it("joins a multi-line blockquote", () => {
    expect(parseMarkdown("> one\n> two")).toEqual([
      { kind: "quote", spans: [{ kind: "text", text: "one two" }] },
    ]);
  });

  it("handles a realistic agent message end to end", () => {
    const src = [
      "## Done — shipped and clean",
      "",
      "Two commits, both pushed:",
      "",
      "- `c6fe96ff` the guard",
      "- `f5cd200a` deployment record",
      "",
      "```bash",
      "git log --oneline",
      "```",
      "",
      "See [the run](https://ci.example.com/42) for details.",
    ].join("\n");

    expect(parseMarkdown(src).map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "code",
      "paragraph",
    ]);
  });

  // Regression (#72): with no table branch, rows fell through to the paragraph branch, which joins
  // lines with a space — a table arrived as one run-on line, the one unsupported construct that
  // degraded into something unreadable rather than merely unformatted.
  describe("tables", () => {
    const text = (s: string) => ({ kind: "text", text: s });

    it("parses the pipe-delimited form", () => {
      const src = ["| Option | Cost |", "| --- | --- |", "| A | low |", "| B | high |"].join("\n");
      expect(parseMarkdown(src)).toEqual([
        {
          kind: "table",
          align: [null, null],
          header: [[text("Option")], [text("Cost")]],
          rows: [
            [[text("A")], [text("low")]],
            [[text("B")], [text("high")]],
          ],
        },
      ]);
    });

    it("parses the form without outer pipes", () => {
      const src = ["Option | Cost", "--- | ---", "A | low"].join("\n");
      expect(parseMarkdown(src)).toEqual([
        {
          kind: "table",
          align: [null, null],
          header: [[text("Option")], [text("Cost")]],
          rows: [[[text("A")], [text("low")]]],
        },
      ]);
    });

    it("reads column alignment off the delimiter row", () => {
      const src = ["| l | c | r | n |", "| :-- | :-: | --: | --- |", "| 1 | 2 | 3 | 4 |"].join("\n");
      const [table] = parseMarkdown(src);
      expect(table).toMatchObject({ kind: "table", align: ["left", "center", "right", null] });
    });

    it("inline-parses cells", () => {
      const src = ["| Flag | Default |", "|------|---------|", "| `--wrap` | **on** |"].join("\n");
      const [table] = parseMarkdown(src);
      expect(table).toMatchObject({
        rows: [[[{ kind: "code", text: "--wrap" }], [{ kind: "bold", spans: [text("on")] }]]],
      });
    });

    it("squares off ragged rows against the header", () => {
      const src = ["| a | b |", "| --- | --- |", "| 1 |", "| 1 | 2 | 3 |"].join("\n");
      const [table] = parseMarkdown(src);
      expect(table).toMatchObject({
        rows: [
          [[text("1")], []],
          [[text("1")], [text("2")]],
        ],
      });
    });

    it("treats an escaped pipe as a cell character, not a column break", () => {
      const src = ["| a | b |", "| --- | --- |", "| x \\| y | z |"].join("\n");
      const [table] = parseMarkdown(src);
      expect(table).toMatchObject({ rows: [[[text("x | y")], [text("z")]]] });
    });

    // The delimiter row is the whole signal: a bare `---` is still a rule, and a paragraph that
    // happens to contain a pipe is still a paragraph.
    it("does not eat prose that merely contains a pipe", () => {
      expect(parseMarkdown("run a | b\nthen c").map((b) => b.kind)).toEqual(["paragraph"]);
      expect(parseMarkdown("---").map((b) => b.kind)).toEqual(["rule"]);
    });

    // GFM's own rule, and load-bearing rather than pedantic: without it any prose line holding a
    // pipe, above any dashed line, becomes a two-column table split at that pipe.
    it("refuses a delimiter row that doesn't match the header's width", () => {
      const src = ["a | b | c", "--- | ---", "1 | 2 | 3"].join("\n");
      expect(parseMarkdown(src).map((b) => b.kind)).toEqual(["paragraph"]);
    });

    it("refuses a delimiter cell that isn't dashes", () => {
      expect(parseMarkdown("a | b\n--- | x").map((b) => b.kind)).toEqual(["paragraph"]);
      expect(parseMarkdown("a | b\n--- | :").map((b) => b.kind)).toEqual(["paragraph"]);
    });

    it("ends the table at a blank line and starts after a paragraph", () => {
      const src = ["intro", "| a |", "| --- |", "| 1 |", "", "after"].join("\n");
      expect(parseMarkdown(src).map((b) => b.kind)).toEqual(["paragraph", "table", "paragraph"]);
    });
  });

  it("empty input yields no blocks", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});

// The Files view hands this parser a whole 1 MiB file, so a hostile line must not freeze the tab. The
// 200 ms ceiling is two orders over a healthy run and an order under the 3.7 s the unbounded link
// branch took on 80,000 `[` (review, 1.17.0).
describe("hostile input stays fast", () => {
  const FAST_MS = 200;
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  it("a 200,000 character line of '[' parses in under 200 ms", () => {
    const line = "[".repeat(200_000);
    expect(time(() => parseMarkdown(line))).toBeLessThan(FAST_MS);
  });

  it("a 200,000 character line of '**a ' parses in under 200 ms", () => {
    const line = "**a ".repeat(50_000);
    expect(time(() => parseMarkdown(line))).toBeLessThan(FAST_MS);
  });

  it("the inline parser alone is bounded too, for a long run of '[' and of '**a '", () => {
    expect(time(() => parseInline("[".repeat(60_000)))).toBeLessThan(FAST_MS);
    expect(time(() => parseInline("**a ".repeat(15_000)))).toBeLessThan(FAST_MS);
  });

  it("many short lines that glue into one paragraph stay fast", () => {
    const source = "[[[[[[[[[[\n".repeat(100_000);
    expect(time(() => parseMarkdown(source))).toBeLessThan(FAST_MS);
  });

  it("a line over 2000 characters renders as plain text, a shorter one still formats", () => {
    const long = `**bold** ${"x".repeat(2000)}`;
    expect(parseMarkdown(long)).toEqual([{ kind: "paragraph", spans: [{ kind: "text", text: long }] }]);
    expect(parseMarkdown("**bold** short")[0]).toEqual({
      kind: "paragraph",
      spans: [{ kind: "bold", spans: [{ kind: "text", text: "bold" }] }, { kind: "text", text: " short" }],
    });
  });

  it("a link label past 500 characters is not a link", () => {
    const label = "a".repeat(501);
    expect(parseInline(`[${label}](/x)`).some((s) => s.kind === "link")).toBe(false);
    expect(parseInline(`[${"a".repeat(500)}](/x)`).some((s) => s.kind === "link")).toBe(true);
  });
});

// ── Links in every form a README writes them ─────────────────────────────────────────────────────

const text = (t: string): MdSpan => ({ kind: "text", text: t });
const link = (href: string, label: string, rel = false): MdSpan =>
  rel ? { kind: "link", href, spans: [text(label)], rel: true } : { kind: "link", href, spans: [text(label)] };

describe("relative and fragment links", () => {
  it.each([
    ["dot-relative", "./other.md"],
    ["bare", "docs/x.md"],
    ["parent", "../x"],
    ["rooted", "/x.md"],
    ["a fragment", "#install"],
    ["a folder", "docs/"],
  ])("a %s href stays in the tree, flagged, and is never raw text", (_label, href) => {
    expect(parseInline(`see [the page](${href}) now`)).toEqual([text("see "), link(href, "the page", true), text(" now")]);
  });

  it("an external link carries no flag", () => {
    expect(parseInline("[a](https://x.example)")[0]).not.toHaveProperty("rel");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,x"],
    ["file:", "file:///etc/passwd"],
    ["vbscript:", "vbscript:x"],
    ["an unknown scheme", "zzz:thing"],
    ["a protocol-relative host", "//evil.example/x"],
  ])("%s shows the label only", (_label, href) => {
    expect(parseInline(`[label](${href})`)).toEqual([text("label")]);
  });

  it("a refused link inside a paragraph never leaks its source", () => {
    const [block] = parseMarkdown("go [here](javascript:alert(1)) now");
    expect(block).toEqual({ kind: "paragraph", spans: [text("go here now")] });
  });
});

describe("the link forms a README uses", () => {
  it("an autolink loses its angle brackets", () => {
    expect(parseInline("see <https://x.example/a> now")).toEqual([text("see "), link("https://x.example/a", "https://x.example/a"), text(" now")]);
    expect(parseInline("<mailto:a@b.example>")).toEqual([link("mailto:a@b.example", "mailto:a@b.example")]);
  });

  it("an angle-bracketed scheme that is not allowed stays text", () => {
    expect(parseInline("<javascript:alert(1)>")).toEqual([text("<javascript:alert(1)>")]);
  });

  it("a title after the address is dropped, in either quote", () => {
    expect(parseInline('[a](https://x.example "The title")')).toEqual([link("https://x.example", "a")]);
    expect(parseInline("[a](./b.md 'The title')")).toEqual([link("./b.md", "a", true)]);
  });

  it("a URL with one level of balanced parentheses keeps them", () => {
    expect(parseInline("[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) done")).toEqual([
      link("https://en.wikipedia.org/wiki/Foo_(bar)", "wiki"),
      text(" done"),
    ]);
  });

  it("an image reads as its alt text and is not loaded", () => {
    expect(parseInline("a ![the logo](logo.png) b")).toEqual([text("a the logo b")]);
    expect(parseInline("![](logo.png)")).toEqual([]);
  });

  it("a badge is a link whose label is the alt text", () => {
    expect(parseInline("[![Build status](https://ci.example/badge.svg)](https://ci.example/run)")).toEqual([
      link("https://ci.example/run", "Build status"),
    ]);
    expect(parseInline("[![Build](badge.svg)](./CI.md)")).toEqual([link("./CI.md", "Build", true)]);
  });

  it("a badge whose image has no alt falls back to the address", () => {
    expect(parseInline("[![](badge.svg)](https://ci.example)")).toEqual([link("https://ci.example", "https://ci.example")]);
  });
});

describe("reference links", () => {
  const refs = (extra: string) => parseMarkdown(extra);

  it("[a][ref], [a][] and [ref] use the definition, and the definition is not drawn", () => {
    const blocks = refs(["See [the docs][d], [guide][] and [api].", "", "[d]: https://x.example/docs", "[Guide]: ./guide.md", "[API]: <https://x.example/api> \"API\""].join("\n"));
    expect(blocks).toEqual([
      {
        kind: "paragraph",
        spans: [
          text("See "),
          link("https://x.example/docs", "the docs"),
          text(", "),
          link("./guide.md", "guide", true),
          text(" and "),
          link("https://x.example/api", "api"),
          text("."),
        ],
      },
    ]);
  });

  it("a definition directly under a paragraph line does not become part of it", () => {
    expect(refs("see [a]\n[a]: https://x.example")).toEqual([{ kind: "paragraph", spans: [text("see "), link("https://x.example", "a")] }]);
  });

  it("a bracket nobody defined stays text, and what is inside it still formats", () => {
    expect(parseMarkdown("a [**b**] c [x][nope] [link](https://x.example)")).toEqual([
      {
        kind: "paragraph",
        spans: [
          text("a ["),
          { kind: "bold", spans: [text("b")] },
          text("] c [x][nope] "),
          link("https://x.example", "link"),
        ],
      },
    ]);
  });

  it("labels are matched without regard to case or spacing", () => {
    expect(parseMarkdown("[A  b][x y]\n\n[X   Y]: /z")[0]).toEqual({ kind: "paragraph", spans: [link("/z", "A  b", true)] });
  });

  it("a reference to a refused scheme shows the label only", () => {
    expect(parseMarkdown("[a][x]\n\n[x]: javascript:alert(1)")).toEqual([{ kind: "paragraph", spans: [text("a")] }]);
  });

  it("the first definition of a label wins", () => {
    expect(parseMarkdown("[a]\n\n[a]: https://one.example\n[a]: https://two.example")[0]).toEqual({
      kind: "paragraph",
      spans: [link("https://one.example", "a")],
    });
  });

  it("a definition inside a fenced block is code, not a definition", () => {
    const blocks = parseMarkdown("[a]\n\n```\n[a]: https://x.example\n```");
    expect(blocks[0]).toEqual({ kind: "paragraph", spans: [text("[a]")] });
    expect(blocks[1]).toEqual({ kind: "code", lang: "", text: "[a]: https://x.example" });
  });

  it("a footnote marker is not a definition", () => {
    expect(parseMarkdown("[^1]: a note").map((b) => b.kind)).toEqual(["paragraph"]);
  });

  it("a reference link works in a heading, a list item and a table cell", () => {
    const blocks = parseMarkdown("# [a]\n\n- [a]\n\n| h |\n| - |\n| [a] |\n\n[a]: ./a.md");
    expect(blocks[0]).toEqual({ kind: "heading", level: 1, spans: [link("./a.md", "a", true)] });
    expect(blocks[1]).toEqual({ kind: "list", ordered: false, items: [[link("./a.md", "a", true)]] });
    expect(blocks[2]).toMatchObject({ kind: "table", rows: [[[link("./a.md", "a", true)]]] });
  });
});

describe("heading anchors", () => {
  it.each([
    ["Getting Started", "getting-started"],
    ["What's new?", "whats-new"],
    ["API: v2.0 (beta)", "api-v20-beta"],
    ["snake_case and kebab-case", "snake_case-and-kebab-case"],
    ["Über uns", "über-uns"],
    ["!!!", ""],
  ])("%s becomes %s", (heading, slug) => {
    expect(headingSlug(heading)).toBe(slug);
  });

  it("a repeated heading gets -1, then -2, and a non-heading gets none", () => {
    const blocks = parseMarkdown("# Usage\n\ntext\n\n## Usage\n\n### `Usage`\n\n## ???");
    expect(headingAnchors(blocks)).toEqual(["usage", null, "usage-1", "usage-2", null]);
  });

  it("a heading's anchor is made of its label, formatting and links included", () => {
    expect(headingAnchors(parseMarkdown("## The **bold** [link](https://x.example)"))).toEqual(["the-bold-link"]);
  });
});

// The same ceiling as above, for every pattern this section added: each is one more way to feed the
// regex a line that nearly matches.
describe("the link forms stay fast on hostile input", () => {
  const FAST_MS = 200;
  const time = (run: () => void): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };
  const SIZE = 200_000;
  const hostile: [string, string][] = [
    ["![", "!["],
    ["[![", "[!["],
    ["[a](", "[a]("],
    ["![a](", "![a]("],
    ["[a][", "[a]["],
    ["[a](b ", "[a](b "],
    ["[a](((", "[a]((("],
    ["[a](b(c", "[a](b(c"],
    ["[a](b \"", '[a](b "'],
    ["<https://", "<https://"],
    ["<mailto:", "<mailto:"],
    ["[x] ", "[x] "],
    ["[x][y] ", "[x][y] "],
    ["[![a](b)](", "[![a](b)]("],
  ];

  it.each(hostile)("parseMarkdown on 200,000 characters of %s stays under 200 ms", (_label, unit) => {
    const line = unit.repeat(Math.ceil(SIZE / unit.length));
    expect(time(() => parseMarkdown(line))).toBeLessThan(FAST_MS);
  });

  it.each(hostile)("parseInline alone on 60,000 characters of %s stays under 200 ms", (_label, unit) => {
    const line = unit.repeat(Math.ceil(60_000 / unit.length));
    expect(time(() => parseInline(line, 0, false, new Map([["x", "/x"]])))).toBeLessThan(FAST_MS);
  });

  it("200,000 characters of definition-shaped lines stay fast, and only the cap is honoured", () => {
    const source = "[a]: ".repeat(40_000) + "\n" + "[k]: https://x.example\n".repeat(8_000);
    expect(time(() => parseMarkdown(source))).toBeLessThan(FAST_MS);
  });

  it("many short definition lines stay fast, and each one is skipped", () => {
    const source = Array.from({ length: 20_000 }, (_, n) => `[r${n}]: https://x.example/${n}`).join("\n");
    expect(time(() => parseMarkdown(source))).toBeLessThan(FAST_MS);
    expect(parseMarkdown(source)).toEqual([]);
  });

  it("a long url, label or title past its bound is not a link", () => {
    expect(parseInline(`[a](${"x".repeat(501)})`).some((s) => s.kind === "link")).toBe(false);
    expect(parseInline(`[a](x "${"t".repeat(301)}")`).some((s) => s.kind === "link")).toBe(false);
    expect(parseInline(`[a](${"x".repeat(500)})`).some((s) => s.kind === "link")).toBe(true);
  });
});
