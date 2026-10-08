import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Issue #371. In an installed iPhone app (display-mode: standalone on iOS WebKit) html and body are
// ~59pt shorter than the app column, so the document scrolled on top of the app's own scrollers.
// The fix pins the document in the SAME block that sets `--app-h: 100lvh`. A render test cannot see
// a stylesheet rule, so this one reads the CSS: the pin must sit inside the standalone + iOS block,
// and must appear nowhere else, or Android, desktop and a browser tab lose their normal document.

const css = readFileSync(resolve(import.meta.dirname, "index.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Returns the text between the braces that open at `open` (the index of "{"), nested braces kept. */
function braceBody(source: string, open: number) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
  }
  throw new Error("unbalanced braces in index.css");
}

const mediaAt = css.search(/@media\s*\(display-mode:\s*standalone\)\s*\{/);
const media = braceBody(css, css.indexOf("{", mediaAt));
const supportsAt = media.body.search(/@supports\s*\(-webkit-touch-callout:\s*none\)\s*\{/);
const supports = braceBody(media.body, media.body.indexOf("{", supportsAt));
const outside = css.slice(0, mediaAt) + css.slice(media.end);

describe("the document is pinned in an iOS home-screen launch only (#371)", () => {
  it("has the standalone block with the iOS-only @supports inside it", () => {
    expect(mediaAt).toBeGreaterThanOrEqual(0);
    expect(supportsAt).toBeGreaterThanOrEqual(0);
  });

  it("pins html and body to 100lvh, hidden, with no rubber-band, inside that block", () => {
    const rule = supports.body.match(/html\s*,\s*body\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const decls = rule![1]!;
    expect(decls).toMatch(/height:\s*100lvh\s*;/);
    expect(decls).toMatch(/overflow:\s*hidden\s*;/);
    expect(decls).toMatch(/overscroll-behavior:\s*none\s*;/);
  });

  it("keeps the app height token at 100lvh in the same block", () => {
    expect(supports.body).toMatch(/--app-h:\s*100lvh\s*;/);
  });

  it("puts the pin nowhere else", () => {
    expect(outside).not.toMatch(/html\s*,\s*body\s*\{/);
    expect(outside).not.toMatch(/100lvh/);
    expect(media.body.replace(supports.body, "")).not.toMatch(/html\s*,\s*body/);
  });
});
