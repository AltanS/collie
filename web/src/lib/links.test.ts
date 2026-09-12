import { describe, expect, it } from "vitest";

import { findLinks } from "./links";

describe("findLinks", () => {
  const hrefs = (s: string) => findLinks(s).map((l) => l.href);

  it("finds http(s) URLs and reports ranges that index the source text", () => {
    const text = "see https://herdr.dev/docs for more";
    const [link] = findLinks(text);
    expect(link).toEqual({ start: 4, end: 26, href: "https://herdr.dev/docs" });
    expect(text.slice(link!.start, link!.end)).toBe("https://herdr.dev/docs");
  });

  it("finds several per string, in order", () => {
    expect(hrefs("http://a.dev x https://b.dev/y")).toEqual(["http://a.dev", "https://b.dev/y"]);
  });

  it("leaves scheme-less hosts alone — terminal output is full of dotted tokens", () => {
    expect(hrefs("edit web/src/lib/links.ts, bump to v0.21.0, ping www.example.com")).toEqual([]);
  });

  // The whole XSS story: a dangerous scheme is unmatchable, not filtered out later.
  it("never links a non-http scheme", () => {
    expect(hrefs("javascript:alert(1) data:text/html,x file:///etc/passwd mailto:a@b.dev")).toEqual(
      [],
    );
  });

  it("drops trailing prose punctuation", () => {
    expect(hrefs("Open https://a.dev/x.")).toEqual(["https://a.dev/x"]);
    expect(hrefs("Open https://a.dev/x, then")).toEqual(["https://a.dev/x"]);
    expect(hrefs("Really? https://a.dev/x!")).toEqual(["https://a.dev/x"]);
  });

  it("drops an unbalanced closing bracket but keeps a balanced one", () => {
    expect(hrefs("(https://a.dev/x)")).toEqual(["https://a.dev/x"]);
    expect(hrefs("https://a.dev/Foo_(bar)")).toEqual(["https://a.dev/Foo_(bar)"]);
  });

  it("stops at the characters that delimit a URL in prose", () => {
    expect(hrefs('<https://a.dev/x> "https://b.dev/y" `https://c.dev/z`')).toEqual([
      "https://a.dev/x",
      "https://b.dev/y",
      "https://c.dev/z",
    ]);
  });

  it("stops at a newline — a hard-wrapped URL yields only its first fragment", () => {
    expect(hrefs("https://a.dev/very/long\n/tail")).toEqual(["https://a.dev/very/long"]);
  });

  // A stray BEL can survive the SGR parse (it terminates OSC, and lone ones do occur in the wild);
  // it must never reach an href.
  it("keeps control bytes out of the href", () => {
    const bel = String.fromCharCode(7);
    expect(hrefs(`https://a.dev/x${bel}y`)).toEqual(["https://a.dev/x"]);
  });

  it("ignores a scheme with no host", () => {
    expect(hrefs("https:// https://.")).toEqual([]);
  });

  it("keeps query strings, fragments and ports whole", () => {
    expect(hrefs("http://localhost:5173/a?b=c&d=e#frag next")).toEqual([
      "http://localhost:5173/a?b=c&d=e#frag",
    ]);
  });
});

describe("findLinks — a URL the terminal hard-wrapped", () => {
  // What the mirror renders (the grid) and what the pane read with soft wraps undone holds, for
  // the same output: a shell printed one URL longer than the pane, so the grid cut it in two.
  const GRID = ["run this:", "https://a.dev/auth?client=1&scope=x&s", "tate=y&end then"].join("\n");
  const LOGICAL = ["run this:", "https://a.dev/auth?client=1&scope=x&state=y&end then"].join("\n");
  const WHOLE = "https://a.dev/auth?client=1&scope=x&state=y&end";

  it("repairs the fragment's href and links the continuation, from the logical text", () => {
    expect(findLinks(GRID, LOGICAL).map((l) => [GRID.slice(l.start, l.end), l.href])).toEqual([
      ["https://a.dev/auth?client=1&scope=x&s", WHOLE],
      ["tate=y&end", WHOLE],
    ]);
  });

  it("is exactly today's behaviour without a logical text to check against", () => {
    expect(findLinks(GRID).map((l) => l.href)).toEqual(["https://a.dev/auth?client=1&scope=x&s"]);
  });

  it("leaves the fragment alone when two logical URLs start with it", () => {
    const grid = ["go https://a.dev/x", "tail"].join("\n");
    const logical = ["go https://a.dev/x", "or https://a.dev/xy"].join("\n");
    expect(findLinks(grid, logical).map((l) => l.href)).toEqual(["https://a.dev/x"]);
  });

  it("keeps a complete URL complete when the next line does not continue it", () => {
    const grid = ["see https://a.dev/x", "next step"].join("\n");
    const logical = ["see https://a.dev/x", "or https://a.dev/xyz"].join("\n");
    expect(findLinks(grid, logical).map((l) => l.href)).toEqual(["https://a.dev/x"]);
  });

  it("stops at the last character the continuation really matches", () => {
    const grid = ["https://a.dev/abc", "defZZZ"].join("\n");
    const logical = ["https://a.dev/abcdef", "rest"].join("\n");
    const href = "https://a.dev/abcdef";
    expect(findLinks(grid, logical).map((l) => [grid.slice(l.start, l.end), l.href])).toEqual([
      ["https://a.dev/abc", href],
      ["def", href],
    ]);
  });

  // Herdr hands the mirror rows terminated with CR, so a fragment that was cut by the column edge
  // has the CR — not the LF — right after it. The repair has to see that as the end of the line.
  it("repairs a split URL in rows terminated with CR, as the pane read hands them over", () => {
    const grid = "https://a.dev/auth?client=1&s\r\ntate=y then\r\n";
    const logical = "https://a.dev/auth?client=1&state=y then\r\n";
    const href = "https://a.dev/auth?client=1&state=y";
    expect(findLinks(grid, logical).map((l) => [grid.slice(l.start, l.end), l.href])).toEqual([
      ["https://a.dev/auth?client=1&s", href],
      ["tate=y", href],
    ]);
  });

  it("links a URL that spans more than two rows as one tap target", () => {
    const grid = ["https://a.dev/one-two", "-three-four", "-five end"].join("\n");
    const logical = ["https://a.dev/one-two-three-four-five", "end"].join("\n");
    const links = findLinks(grid, logical);
    expect(links.map((l) => l.href)).toEqual(Array(3).fill("https://a.dev/one-two-three-four-five"));
    expect(links.map((l) => grid.slice(l.start, l.end)).join("")).toBe("https://a.dev/one-two-three-four-five");
  });
});

describe("findLinks — a URL the pane shows twice", () => {
  it("adopts the whole URL when the same URL appears more than once in the logical text", () => {
    // A typed command and its output both carry the URL — that is one URL to adopt, not a tie.
    const grid = ["echo https://a.dev/auth?client=1&s", "tate=y", "https://a.dev/auth?client=1&s", "tate=y"].join("\n");
    const logical = ["echo https://a.dev/auth?client=1&state=y", "https://a.dev/auth?client=1&state=y"].join("\n");
    expect(findLinks(grid, logical).map((l) => l.href)).toEqual([
      "https://a.dev/auth?client=1&state=y",
      "https://a.dev/auth?client=1&state=y",
      "https://a.dev/auth?client=1&state=y",
      "https://a.dev/auth?client=1&state=y",
    ]);
  });
});
