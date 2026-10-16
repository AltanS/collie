import { parseMarkdown, type MdBlock, type MdSpan } from "@/lib/markdown";
import { composeStretches, fullSpelling, liftStretches, parseStretches, skimSpelling, stretches, type Segment } from "@/lib/stretch";

// Stretchtext as cc-stretch writes it: `{{short|long}}`. The parse must agree with cc-stretch's own,
// or a key Collie opens is not the key the terminal opened; the composed source must survive
// Collie's Markdown parser so each stretch comes back out as a span of its own.

const prose = (text: string): Segment => ({ kind: "prose", text });
const text = (t: string): MdSpan => ({ kind: "text", text: t });

/** `keys` opened in this order, so the last one is the newest. */
const opened = (keys: readonly string[]): Map<string, number> => new Map(keys.map((key, i) => [key, i + 1]));

/** Words an open stretch added, marked in hue `hue`, soft (`s`) or faded (`f`). */
const tint = (hue: number, tone: "s" | "f", words: string) => `\uE005${hue}${tone}\uE001${words}\uE006`;
const closer = (index: number) => `\uE003${index}\uE004`;

/** The reply as Collie draws it: composed with `open` (opened in that order), parsed, and its stretches lifted. */
function drawn(reply: string, open: readonly string[] = []): MdBlock[] {
  const composed = composeStretches(parseStretches(reply), opened(open));
  return liftStretches(parseMarkdown(composed.source), composed);
}

const noMarks = { keys: [], hues: [] };

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
  const compose = (reply: string, open: readonly string[] = []) => composeStretches(parseStretches(reply), opened(open));

  it("marks a closed stretch's short form with its index", () => {
    expect(compose("say {{a|b}} now")).toEqual({ source: "say \uE0000\uE001a\uE002 now", keys: ["a"], hues: [0] });
  });

  it("draws an open stretch as its long form, its added words tinted, then a space and its closer", () => {
    expect(compose("say {{a|b}} now", ["a"])).toEqual({ source: `say ${tint(0, "s", "b")} ${closer(0)} now`, keys: ["a"], hues: [0] });
  });

  it("puts the closer after a blank line when the long form ends in a fence or a rule", () => {
    expect(compose("{{a|x\n```\ncode\n```\n}}", ["a"]).source).toBe(`${tint(0, "s", "x")}\n\`\`\`\n${tint(0, "s", "code")}\n\`\`\`\n\n${closer(0)}`);
    expect(compose("{{a|x\n\n---}}", ["a"]).source).toBe(`${tint(0, "s", "x")}\n\n---\n\n${closer(0)}`);
  });

  it("composes the stretches inside an open long form by the same rules", () => {
    expect(compose("{{a|x {{b|c}} y}}", ["a"])).toEqual({
      source: `${tint(0, "s", "x")} \uE0001\uE001b\uE002 ${tint(0, "s", "y")} ${closer(0)}`,
      keys: ["a", "a › b"],
      hues: [0, 1],
    });
    expect(compose("{{a|x {{b|c}} y}}", ["a", "a › b"]).source).toBe(
      `${tint(0, "f", "x")} ${tint(1, "s", "c")} ${closer(1)} ${tint(0, "f", "y")} ${closer(0)}`,
    );
  });

  it("does not walk a closed stretch's long form", () => {
    expect(compose("{{a|x {{b|c}} y}}").keys).toEqual(["a"]);
  });

  it("draws a short form over several lines as its long form, with no closer and no tint", () => {
    expect(compose("{{a\nb|long}}", ["a\nb"])).toEqual({ source: "long", keys: [], hues: [] });
    expect(compose("{{a\nb|}}").source).toBe("a\nb");
  });

  it("draws a stretch with nothing to open as its short form", () => {
    expect(compose("{{x}} and {{a|b")).toEqual({ source: "x and a", keys: [], hues: [] });
  });

  it("strips a marker the reply wrote itself", () => {
    expect(compose("\uE0000\uE001hi\uE002 {{a|b}}").source).toBe("0hi \uE0000\uE001a\uE002");
    expect(compose("\uE0050s\uE001hi\uE006 {{a|b}}").source).toBe("0shi \uE0000\uE001a\uE002");
  });
});

// cc-stretch's `grow`: the short form's words, found in the long form in order, are anchors and keep
// the text's ink; every other word is one the long form added, and takes the stretch's colour.
describe("composeStretches tints the words an open stretch adds", () => {
  const compose = (reply: string, open: readonly string[]) => composeStretches(parseStretches(reply), opened(open)).source;

  it("tints every word that is not an anchor, a run of them on one line at a time", () => {
    expect(compose("{{monad|a monad is a type}}", ["monad"])).toBe(`${tint(0, "s", "a")} monad ${tint(0, "s", "is a type")} ${closer(0)}`);
  });

  it("finds the anchors bare: punctuation and case aside", () => {
    expect(compose("{{cache|the cache.}}", ["cache"])).toBe(`${tint(0, "s", "the")} cache. ${closer(0)}`);
    expect(compose("{{The Cache|the **cache**, kept}}", ["The Cache"])).toBe(`the **cache**, ${tint(0, "s", "kept")} ${closer(0)}`);
  });

  it("keeps punctuation standing alone right after an anchor with that anchor", () => {
    expect(compose("{{cache|the cache . kept}}", ["cache"])).toBe(`${tint(0, "s", "the")} cache . ${tint(0, "s", "kept")} ${closer(0)}`);
  });

  it("never tints a markdown mark: a bullet, a list number, a fence", () => {
    expect(compose("{{a|\n- one\n1. two\n```ts\ncode\n```\n}}", ["a"])).toBe(
      `\n- ${tint(0, "s", "one")}\n1. ${tint(0, "s", "two")}\n\`\`\`ts\n${tint(0, "s", "code")}\n\`\`\`\n\n${closer(0)}`,
    );
  });

  it("tints the stretch opened last soft and every other open stretch faded", () => {
    expect(compose("{{a|x}} {{b|y}}", ["a", "b"])).toBe(`${tint(0, "f", "x")} ${closer(0)} ${tint(1, "s", "y")} ${closer(1)}`);
    expect(compose("{{a|x}} {{b|y}}", ["b", "a"])).toBe(`${tint(0, "s", "x")} ${closer(0)} ${tint(1, "f", "y")} ${closer(1)}`);
  });

  it("makes no stretch the newest at sequence 0, which a find opens with", () => {
    const { source } = composeStretches(parseStretches("{{a|x}}"), new Map([["a", 0]]));
    expect(source).toBe(`${tint(0, "f", "x")} ${closer(0)}`);
  });
});

describe("composeStretches hues", () => {
  const hues = (reply: string, open: readonly string[] = []) => composeStretches(parseStretches(reply), opened(open)).hues;

  it("gives the k-th stretch hue k mod 4, so the fifth wraps to the first", () => {
    expect(hues("{{a|1}} {{b|2}} {{c|3}} {{d|4}} {{e|5}}")).toEqual([0, 1, 2, 3, 0]);
  });

  it("counts a stretch it does not mark, so a hue stays with its stretch whatever is open", () => {
    expect(hues("{{a|x {{b|y}}}} {{c|z}}")).toEqual([0, 2]);
    expect(hues("{{a|x {{b|y}}}} {{c|z}}", ["a"])).toEqual([0, 1, 2]);
  });

  it("moves a nested stretch off its parent's hue", () => {
    expect(hues("{{a|{{b|1}} {{c|2}} {{d|3}} {{e|4}}}}", ["a"])).toEqual([0, 1, 2, 3, 1]);
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
  const stretch = (key: string, hue: number, spans: MdSpan[]): MdSpan => ({ kind: "stretch", key, hue, spans });
  const tinted = (hue: number, faded: boolean, spans: MdSpan[]): MdSpan => ({ kind: "tint", hue, faded, spans });

  it("lifts a stretch in a paragraph", () => {
    expect(drawn("say {{a|b}} now")).toEqual([{ kind: "paragraph", spans: [text("say "), stretch("a", 0, [text("a")]), text(" now")] }]);
  });

  it("lifts a stretch with its hue", () => {
    expect(drawn("{{a|1}} {{b|2}}")).toEqual([{ kind: "paragraph", spans: [stretch("a", 0, [text("a")]), text(" "), stretch("b", 1, [text("b")])] }]);
  });

  it("lifts a stretch inside bold", () => {
    expect(drawn("**{{a|b}}** x")).toEqual([{ kind: "paragraph", spans: [{ kind: "bold", spans: [stretch("a", 0, [text("a")])] }, text(" x")] }]);
  });

  it("lifts a short form that holds code, its markers in different text spans", () => {
    expect(drawn("{{use `x`|b}}")).toEqual([{ kind: "paragraph", spans: [stretch("use `x`", 0, [text("use "), { kind: "code", text: "x" }])] }]);
  });

  it("lifts a stretch in a list item, a table cell and a heading", () => {
    expect(drawn("- {{a|b}}")).toEqual([{ kind: "list", ordered: false, items: [[stretch("a", 0, [text("a")])]] }]);
    const [table] = drawn("| h |\n| --- |\n| {{a|b}} |");
    expect(table?.kind === "table" ? table.rows : null).toEqual([[[stretch("a", 0, [text("a")])]]]);
    // The copy button copies `source`, so no marker may survive in it.
    expect(table?.kind === "table" ? table.source : null).toBe("| h |\n| --- |\n| a |");
    expect(drawn("# {{a|b}}")).toEqual([{ kind: "heading", level: 1, spans: [stretch("a", 0, [text("a")])] }]);
  });

  it("keeps a stretch inside a link label as plain text", () => {
    expect(drawn("[{{a|b}}](https://x.example)")).toEqual([
      { kind: "paragraph", spans: [{ kind: "link", href: "https://x.example", spans: [text("a")] }] },
    ]);
  });

  it("keeps the words of markers that do not pair up at one level", () => {
    expect(drawn("{{**a|b}} c**")).toEqual([{ kind: "paragraph", spans: [{ kind: "bold", spans: [text("a c")] }] }]);
    expect(liftStretches(parseMarkdown("x \uE0005\uE001y\uE002 z \uE0039\uE004"), noMarks)).toEqual([{ kind: "paragraph", spans: [text("x y z ")] }]);
  });

  it("keeps the words of a tint that does not pair up at one level", () => {
    expect(liftStretches(parseMarkdown("\uE0050s\uE001**y\uE006 z**"), noMarks)).toEqual([{ kind: "paragraph", spans: [{ kind: "bold", spans: [text("y z")] }] }]);
    expect(liftStretches(parseMarkdown("a\uE006 b \uE0051f\uE001c"), noMarks)).toEqual([{ kind: "paragraph", spans: [text("a b c")] }]);
  });

  it("lifts an open stretch's tinted words and its closer, both in its hue", () => {
    expect(drawn("say {{a|b}} now", ["a"])).toEqual([
      { kind: "paragraph", spans: [text("say "), tinted(0, false, [text("b")]), text(" "), { kind: "stretch-close", key: "a", hue: 0 }, text(" now")] },
    ]);
  });

  it("lifts a tint around emphasis, and faded for a stretch not opened last", () => {
    expect(drawn("{{a|**b c**}} {{d|e}}", ["a", "d"])).toEqual([
      {
        kind: "paragraph",
        spans: [
          tinted(0, true, [{ kind: "bold", spans: [text("b c")] }]),
          text(" "),
          { kind: "stretch-close", key: "a", hue: 0 },
          text(" "),
          tinted(1, false, [text("e")]),
          text(" "),
          { kind: "stretch-close", key: "d", hue: 1 },
        ],
      },
    ]);
  });

  it("strips a marker from a code block", () => {
    expect(liftStretches([{ kind: "code", lang: "", text: "a\uE002b\uE0001\uE001c" }], noMarks)).toEqual([{ kind: "code", lang: "", text: "abc" }]);
    expect(liftStretches([{ kind: "code", lang: "", text: "a\uE0052s\uE001b\uE006c" }], noMarks)).toEqual([{ kind: "code", lang: "", text: "abc" }]);
  });
});
