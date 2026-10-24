import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PRODUCT_NAME, Wordmark } from "@/components/wordmark";

const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
/** The wordmark's own block, so a rule elsewhere cannot satisfy a guard meant for this one. */
const start = css.indexOf("\n.wordmark-ink:nth-child(1)");
const rules = css.slice(start, css.indexOf("/* Submission progress bar"));


describe("the wordmark", () => {
  it("is the name with the stem as text and PWA as three inked letters", () => {
    const { container } = render(<Wordmark />);
    expect(container.textContent).toBe(PRODUCT_NAME);
    expect([...container.querySelectorAll(".wordmark-ink")].map((el) => el.textContent)).toEqual(["P", "W", "A"]);
    // The stem is a text node, so the letters are children one, two and three.
    expect(container.firstElementChild?.children).toHaveLength(3);
    expect(container.firstElementChild?.className).toContain("tracking-[0.03em]");
  });

  it("wears the three status inks at rest, one per letter, and no hover rule", () => {
    expect(rules).toMatch(/\.wordmark-ink:nth-child\(1\) \{\s*color: var\(--status-done\)/);
    expect(rules).toMatch(/\.wordmark-ink:nth-child\(2\) \{\s*color: var\(--status-working\)/);
    expect(rules).toMatch(/\.wordmark-ink:nth-child\(3\) \{\s*color: var\(--status-blocked\)/);
    expect(rules).not.toMatch(/:hover|:focus/);
  });

  it("does not animate", () => {
    expect(rules).not.toContain("@keyframes");
    expect(rules).not.toMatch(/\banimation(-[a-z]+)?:/);
  });
});
