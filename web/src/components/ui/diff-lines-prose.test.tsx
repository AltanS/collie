import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DIFF_WRAP_MARK, DiffLines, ProseText, wrapWords } from "@/components/ui/diff-lines";

// Prose wraps at spaces (the coordinator's ask after review 8): an agent view's rules, and any `.md` file
// on a card, go on in the row after with the wrap mark, never in the middle of a word.

describe("wrapWords", () => {
  it("breaks after the last space that fits, keeps every character, and cuts a word only when it alone is too long", () => {
    const text = "Keep one screen to one question or one result.";
    const pieces = wrapWords(text, 20);
    expect(pieces).toEqual(["Keep one screen to ", "one question or one ", "result."]);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) expect([...piece].length).toBeLessThanOrEqual(20);
    expect(wrapWords("abcdefghijklmnopqrstuvwxyz end", 10)).toEqual(["abcdefghij", "klmnopqrst", "uvwxyz end"]);
    expect(wrapWords("short", 20)).toEqual(["short"]);
    expect(wrapWords("anything", 0)).toEqual(["anything"]);
  });
});

describe("a .md file on a card wraps at spaces", () => {
  it("a prose diff's rows go on at a space, each marked", () => {
    const { container } = render(<DiffLines lines={["+Keep one screen to one question or one result."]} file="rules.md" wrap prose cols={20} />);
    const rows = [...container.querySelectorAll("[data-diff-line] > div")].map((row) => row.textContent);
    expect(rows).toEqual(["+Keep one screen to ", `${DIFF_WRAP_MARK}one question or one `, `${DIFF_WRAP_MARK}result.`]);
  });
});

describe("ProseText: the About sheet's rules, wrapped the same way", () => {
  it("one element per line, continuations marked by the wrap mark outside the text, and the text is the bytes", () => {
    const text = "Keep one screen to one question or one result.\n\n-not a deletion\n";
    const { container } = render(<ProseText text={text} cols={20} data-line="rules-text" />);
    const pre = container.querySelector('[data-line="rules-text"]');
    expect(pre?.textContent).toBe(text);
    const lines = [...(pre?.querySelectorAll("[data-prose-line]") ?? [])];
    expect(lines.map((line) => line.textContent)).toEqual(["Keep one screen to one question or one result.\n", "\n", "-not a deletion\n"]);
    const wraps = [...(lines[0]?.querySelectorAll("[data-prose-wrap]") ?? [])].map((piece) => piece.textContent);
    expect(wraps).toEqual(["one question or one ", "result.\n"]);
    expect(lines[0]?.querySelector("[data-prose-wrap]")?.className).toContain(`before:content-['${DIFF_WRAP_MARK}']`);
    // Never markdown: no element but the line and piece spans.
    expect(pre?.querySelectorAll(":not([data-prose-line]):not([data-prose-piece]):not([data-prose-wrap])").length).toBe(0);
  });
});
