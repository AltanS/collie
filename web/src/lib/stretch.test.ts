import { parseMarkdown, type MdBlock, type MdSpan } from "@/lib/markdown";
import { composeStretches, fullSpelling, liftStretches, parseStretches, skimSpelling, stretches, type Segment } from "@/lib/stretch";

// Stretchtext as cc-stretch writes it: `{{short|long}}`. The parse must agree with cc-stretch's own,
// or a key Collie opens is not the key the terminal opened; the composed source must survive
// Collie's Markdown parser so each stretch comes back out as a span of its own.

const prose = (text: string): Segment => ({ kind: "prose", text });
const text = (t: string): MdSpan => ({ kind: "text", text: t });

/** The reply as Collie draws it: composed with `open`, parsed, and its stretches lifted. */
function drawn(reply: string, open: readonly string[] = []): MdBlock[] {
  const { source, keys } = composeStretches(parseStretches(reply), new Set(open));
  return liftStretches(parseMarkdown(source), keys);
}

describe("parseStretches", () => {
  it("reads plain text as one prose segment", () => {
    expect(parseStretches("plain words")).toEqual([prose("plain words")]);
  });

  it("reads a stretch's short and long forms", () => {
    expect(parseStretches("see {{a|b}} now")).toEqual([
      prose("see "),
      { kind: "stretch", key: "a", short: "a", long: [prose("b")], isClosed: true },
      prose(" now"),
    ]);
  });

  it("nests a stretch inside a long form, keyed under its parent", () => {
    const [outer] = parseStretches("{{a|x {{b|c}} y}}");
    expect(outer).toEqual({
      kind: "stretch",
      key: "a",
      short: "a",
      long: [prose("x "), { kind: "stretch", key: "a › b", short: "b", long: [prose("c")], isClosed: true }, prose(" y")],
      isClosed: true,
    });
  });

  it("leaves the long form undefined when no pipe was written", () => {
    expect(parseStretches("{{x}}")).toEqual([{ kind: "stretch", key: "", short: "x", long: undefined, isClosed: true }]);
  });

  it("marks a stretch whose closing braces have not arrived", () => {
    expect(parseStretches("{{a|b")).toEqual([{ kind: "stretch", key: "a", short: "a", long: [prose("b")], isClosed: false }]);
  });

  it("keeps a short form over several lines", () => {
    expect(stretches(parseStretches("{{a\nb|c}}"))[0]?.short).toBe("a\nb");
  });

  it("keeps a stray closer as text", () => {
    expect(parseStretches("x }} y")).toEqual([prose("x }} y")]);
  });

  it("opens no stretch inside a code span or a fence", () => {
    expect(parseStretches("`{{a|b}}` z")).toEqual([prose("`{{a|b}}` z")]);
    expect(parseStretches("```\n{{a|b}}\n```\n")).toEqual([prose("```\n{{a|b}}\n```\n")]);
  });

  it("numbers a short form repeated among siblings", () => {
    expect(stretches(parseStretches("{{a|1}} {{a|2}} {{a|3}}")).map((s) => s.key)).toEqual(["a", "a~2", "a~3"]);
  });
});

describe("composeStretches", () => {
  const compose = (reply: string, open: readonly string[] = []) => composeStretches(parseStretches(reply), new Set(open));

  it("marks a closed stretch's short form with its index", () => {
    expect(compose("say {{a|b}} now")).toEqual({ source: "say \uE0000\uE001a\uE002 now", keys: ["a"] });
  });

  it("draws an open stretch as its long form, then a space and its closer", () => {
    expect(compose("say {{a|b}} now", ["a"])).toEqual({ source: "say b \uE0030\uE004 now", keys: ["a"] });
  });

  it("puts the closer after a blank line when the long form ends in a fence or a rule", () => {
    expect(compose("{{a|x\n```\ncode\n```\n}}", ["a"]).source).toBe("x\n```\ncode\n```\n\n\uE0030\uE004");
    expect(compose("{{a|x\n\n---}}", ["a"]).source).toBe("x\n\n---\n\n\uE0030\uE004");
  });

  it("composes the stretches inside an open long form by the same rules", () => {
    expect(compose("{{a|x {{b|c}} y}}", ["a"])).toEqual({ source: "x \uE0001\uE001b\uE002 y \uE0030\uE004", keys: ["a", "a › b"] });
    expect(compose("{{a|x {{b|c}} y}}", ["a", "a › b"]).source).toBe("x c \uE0031\uE004 y \uE0030\uE004");
  });

  it("does not walk a closed stretch's long form", () => {
    expect(compose("{{a|x {{b|c}} y}}").keys).toEqual(["a"]);
  });

  it("draws a short form over several lines as its long form, with no closer", () => {
    expect(compose("{{a\nb|long}}", ["a\nb"])).toEqual({ source: "long", keys: [] });
    expect(compose("{{a\nb|}}").source).toBe("a\nb");
  });

  it("draws a stretch with nothing to open as its short form", () => {
    expect(compose("{{x}} and {{a|b")).toEqual({ source: "x and a", keys: [] });
  });

  it("strips a marker the reply wrote itself", () => {
    expect(compose("\uE0000\uE001hi\uE002 {{a|b}}").source).toBe("0hi \uE0000\uE001a\uE002");
  });
});

describe("skimSpelling and fullSpelling", () => {
  const reply = "Lead {{a|x {{b|c}} y}} and {{d}} tail";

  it("spells every stretch closed, short forms as text", () => {
    expect(skimSpelling(reply)).toBe("Lead a and d tail");
  });

  it("spells every stretch open, with no closers", () => {
    expect(fullSpelling(reply)).toBe("Lead x c y and d tail");
  });
});

describe("liftStretches", () => {
  const stretch = (key: string, spans: MdSpan[]): MdSpan => ({ kind: "stretch", key, spans });

  it("lifts a stretch in a paragraph", () => {
    expect(drawn("say {{a|b}} now")).toEqual([{ kind: "paragraph", spans: [text("say "), stretch("a", [text("a")]), text(" now")] }]);
  });

  it("lifts a stretch inside bold", () => {
    expect(drawn("**{{a|b}}** x")).toEqual([{ kind: "paragraph", spans: [{ kind: "bold", spans: [stretch("a", [text("a")])] }, text(" x")] }]);
  });

  it("lifts a short form that holds code, its markers in different text spans", () => {
    expect(drawn("{{use `x`|b}}")).toEqual([{ kind: "paragraph", spans: [stretch("use `x`", [text("use "), { kind: "code", text: "x" }])] }]);
  });

  it("lifts a stretch in a list item, a table cell and a heading", () => {
    expect(drawn("- {{a|b}}")).toEqual([{ kind: "list", ordered: false, items: [[stretch("a", [text("a")])]] }]);
    const [table] = drawn("| h |\n| --- |\n| {{a|b}} |");
    expect(table?.kind === "table" ? table.rows : null).toEqual([[[stretch("a", [text("a")])]]]);
    // The copy button copies `source`, so no marker may survive in it.
    expect(table?.kind === "table" ? table.source : null).toBe("| h |\n| --- |\n| a |");
    expect(drawn("# {{a|b}}")).toEqual([{ kind: "heading", level: 1, spans: [stretch("a", [text("a")])] }]);
  });

  it("keeps a stretch inside a link label as plain text", () => {
    expect(drawn("[{{a|b}}](https://x.example)")).toEqual([
      { kind: "paragraph", spans: [{ kind: "link", href: "https://x.example", spans: [text("a")] }] },
    ]);
  });

  it("keeps the words of markers that do not pair up at one level", () => {
    expect(drawn("{{**a|b}} c**")).toEqual([{ kind: "paragraph", spans: [{ kind: "bold", spans: [text("a c")] }] }]);
    expect(liftStretches(parseMarkdown("x \uE0005\uE001y\uE002 z \uE0039\uE004"), [])).toEqual([{ kind: "paragraph", spans: [text("x y z ")] }]);
  });

  it("lifts an open stretch's closer", () => {
    expect(drawn("say {{a|b}} now", ["a"])).toEqual([
      { kind: "paragraph", spans: [text("say b "), { kind: "stretch-close", key: "a" }, text(" now")] },
    ]);
  });

  it("strips a marker from a code block", () => {
    expect(liftStretches([{ kind: "code", lang: "", text: "a\uE002b\uE0001\uE001c" }], [])).toEqual([{ kind: "code", lang: "", text: "abc" }]);
  });
});
