import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltGroundSection } from "./belt-ground";

// The seven cards this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-ground-today",
  "belt-ground-option-1",
  "belt-ground-option-2",
  "belt-ground-option-3",
  "belt-ground-option-4",
  "belt-ground-option-5",
  "belt-ground-option-6",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Six of them, one
 *  per tint, plus the unnumbered "As today" card they are measured against. */
const OPTIONS = [1, 2, 3, 4, 5, 6] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Belt scroller ground section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<BeltGroundSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 6", () => {
    const { container } = render(<BeltGroundSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
    expect(labels.filter((text) => text.startsWith("Option "))).toHaveLength(OPTIONS.length);
    expect(labels).toContain("As today");
  });

  it("carries the general pills and the harness section on every card, from the real ActionsRow", () => {
    render(<BeltGroundSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(card.textContent).toContain("Keys");
      expect(card.textContent).toContain("Type");
      expect(card.textContent).toContain("Quick");
      expect(card.textContent).toContain("Agent");
      // The harness bar's own item for Claude Code — "Model" — rather than a drawn "Claude" label:
      // the real HarnessBar names its brand through an aria-hidden icon, never visible text.
      expect(card.textContent).toContain("Model");
    }
  });

  it("mounts the real ActionsRow, not a drawn copy, on every card", () => {
    const { container } = render(<BeltGroundSection />);
    // The real component's own marker, `data-slot="composer-actions"` — one per card.
    const rows = container.querySelectorAll('[data-slot="composer-actions"]');
    expect(rows).toHaveLength(HANDLES.length);
  });
});
