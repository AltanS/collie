import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StripsCompactSection } from "./strips-compact";

// The six cards this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "strips-compact-as-today",
  "strips-compact-option-1",
  "strips-compact-option-2",
  "strips-compact-option-3",
  "strips-compact-option-4",
  "strips-compact-option-5",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Five of them, one
 *  per idea, plus the unnumbered "As today" card they are measured against. */
const OPTIONS = [1, 2, 3, 4, 5] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Compact strips section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<StripsCompactSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 5", () => {
    const { container } = render(<StripsCompactSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
    // The first card is unnumbered on purpose — "As today" is not an option.
    expect(labels.filter((text) => text.startsWith("Option "))).toHaveLength(OPTIONS.length);
    expect(labels).toContain("As today");
  });

  it("carries the same two tabs and two panes on every card", () => {
    render(<StripsCompactSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(card.textContent).toContain("work");
      expect(card.textContent).toContain("tab 2");
      expect(card.textContent).toContain("daily fact checks and fixes");
      expect(card.textContent).toContain("investigation");
    }
  });
});
