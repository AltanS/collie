import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CollieWordmark, WORDMARK_NAME } from "@/components/collie-wordmark";

const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
/** The wordmark's own block, so a rule elsewhere cannot satisfy a guard meant for this one. */
const start = css.indexOf("\n.wordmark-ink {");
const rules = css.slice(start, css.indexOf("/* Pinch to zoom off"));

describe("the wordmark", () => {
  it("is one image named ColliePWA, with the stem in one path and P, W, A as three inked paths", () => {
    const { container } = render(<CollieWordmark className="text-lg" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe(WORDMARK_NAME);
    expect(WORDMARK_NAME).toBe("ColliePWA");
    expect(svg?.getAttribute("class")).toContain("text-lg");
    // No live text: the name is outlines, so no font is involved.
    expect(container.textContent).toBe("");
    const inks = [...container.querySelectorAll(".wordmark-ink")];
    expect(inks.map((el) => el.getAttribute("class"))).toEqual([
      "wordmark-ink wordmark-ink-p",
      "wordmark-ink wordmark-ink-w",
      "wordmark-ink wordmark-ink-a",
    ]);
    // "Collie" is the path before them, in the text colour.
    expect(svg?.firstElementChild?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.firstElementChild?.getAttribute("class")).toBeNull();
  });

  it("rests in the muted ink and takes the three status inks only under the lockup's pointer", () => {
    expect(rules).toMatch(/\.wordmark-ink \{\s*color: var\(--muted-foreground\)/);
    expect(rules).toMatch(/\.wordmark-ink-p \{\s*--wordmark-lit: var\(--status-done\)/);
    expect(rules).toMatch(/\.wordmark-ink-w \{\s*--wordmark-lit: var\(--status-working\)/);
    expect(rules).toMatch(/\.wordmark-ink-a \{\s*--wordmark-lit: var\(--status-blocked\)/);
    expect(rules).toMatch(/\.wordmark-lockup:hover \.wordmark-ink/);
    expect(rules).not.toContain(":nth-child");
  });

  it("does not animate", () => {
    expect(rules).not.toContain("@keyframes");
    expect(rules).not.toMatch(/\banimation(-[a-z]+)?:/);
  });
});
