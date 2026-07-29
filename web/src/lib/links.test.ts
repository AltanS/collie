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
