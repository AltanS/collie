import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CHIP_MAX, isChipValue, valueSentence } from "@/components/trick-value";

// THE CHIP RULE (2026-11-21): a chip holds a short literal value; a phrase or a list is emphasised plain text in
// the row, with the same words in the same order.

function drawn(key: Parameters<typeof valueSentence>[0], values: Parameters<typeof valueSentence>[1]) {
  const { container } = render(<p>{valueSentence(key, values)}</p>);
  const row = container.firstElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("no row drawn");
  return row;
}

describe("the chip rule", () => {
  it("keeps a short literal on a chip", () => {
    expect(isChipValue("5 min")).toBe(true);
    expect(isChipValue("KETTLE_TOKEN")).toBe(true);
    expect(isChipValue("x".repeat(CHIP_MAX))).toBe(true);
    const row = drawn("settings.tricks.about.version", { version: "1.2.0" });
    expect(row.querySelector('[data-slot="trick-value"]')?.textContent).toBe("1.2.0");
    expect(row.querySelector('[data-slot="trick-value-text"]')).toBeNull();
  });

  it("draws a long value or a list with no chip, as emphasised text, with the same words", () => {
    expect(isChipValue("x".repeat(CHIP_MAX + 1))).toBe(false);
    expect(isChipValue("A, B")).toBe(false);
    const places = "a page of its own (a row under Tricks on the Dashboard), the end of the Belt in each session";
    const row = drawn("settings.tricks.about.shows", { places });
    expect(row.querySelector('[data-slot="trick-value"]')).toBeNull();
    const text = row.querySelector('[data-slot="trick-value-text"]');
    expect(text?.textContent).toBe(places);
    expect(text?.className).toContain("font-medium");
    expect(text?.className).not.toMatch(/\b(border|bg-muted)\b/);
    expect(row).toHaveTextContent(`It shows in: ${places}.`);
    const names = drawn("settings.tricks.about.env", { names: "A_KEY, B_KEY" });
    expect(names.querySelector('[data-slot="trick-value"]')).toBeNull();
    expect(names).toHaveTextContent("Asks for the environment names A_KEY, B_KEY.");
  });
});
