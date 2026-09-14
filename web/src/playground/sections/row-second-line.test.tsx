import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RowSecondLineSection } from "./row-second-line";

// The seven cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "row-second-line-centered",
  "row-second-line-cwd",
  "row-second-line-position",
  "row-second-line-raw",
  "row-second-line-b-shipped",
  "row-second-line-b-hidden",
  "row-second-line-c",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Seven of them, one
 *  per idea, continuous — this is the assertion that keeps them that way. */
const OPTIONS = [1, 2, 3, 4, 5, 6, 7] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Blank tab line and other multiplexers section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<RowSecondLineSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 7", () => {
    const { container } = render(<RowSecondLineSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
  });

  it("mounts the real dashboard list on every card — every option shows at least one pane row", () => {
    render(<RowSecondLineSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      // Every pane row is its own <button> (AgentCard) — at least one per card, whatever its group.
      expect(card.querySelectorAll("button").length).toBeGreaterThan(0);
    }
  });

  it("centres the blank slot on option 1, and shows the shipped repeated name on option 5", () => {
    render(<RowSecondLineSection />);
    // Option 1's unnamed tab carries no second line of text for its agent row — "kaz work" is the
    // only text in its row's title block.
    const centered = cardFor("row-second-line-centered");
    expect(centered.textContent).toContain("kaz work");
    // Option 5 repeats the auto process name across every row.
    const shipped = cardFor("row-second-line-b-shipped");
    const bashCount = (shipped.textContent?.match(/bash/gu) ?? []).length;
    expect(bashCount).toBeGreaterThanOrEqual(6);
  });
});
