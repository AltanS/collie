import { parseInline, parseMarkdown, safeHref } from "./markdown";

// The Markdown grammar for transcript prose. It exists because agent output IS Markdown and reading
// `## Heading` / `**bold**` raw on a phone is worse than reading it formatted — but it must never
// produce markup, only an AST the renderer turns into React elements (the repo's XSS boundary).
//
// The two deliberate omissions below (underscore emphasis, space-flanked asterisks) are the ones
// that matter for CODE-HEAVY text, which is what agents actually emit.

describe("safeHref", () => {
  it.each([
    ["https", "https://example.com"],
    ["http", "http://example.com"],
    ["mailto", "mailto:a@b.com"],
    ["rooted path", "/pane/w1:p1"],
    ["fragment", "#section"],
  ])("allows %s", (_label, href) => {
    expect(safeHref(href)).toBe(href);
  });

  // A link is the one place this view could hand a URL straight to the browser.
  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["JaVaScRiPt: (case dodge)", "JaVaScRiPt:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["vbscript:", "vbscript:msgbox(1)"],
    ["a bare word", "notaurl"],
    ["empty", "   "],
  ])("refuses %s", (_label, href) => {
    expect(safeHref(href)).toBeNull();
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

  it("an unsafe link keeps its literal text instead of becoming an anchor", () => {
    const src = "[click](javascript:alert(1))";
    const spans = parseInline(src);
    expect(spans.every((s) => s.kind !== "link")).toBe(true);
    expect(spans.map((s) => ("text" in s ? s.text : "")).join("")).toContain("click");
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
