import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PaneMarkerSection } from "./pane-marker";

// The seven cards this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "pane-marker-today",
  "pane-marker-eyebrow",
  "pane-marker-glyph",
  "pane-marker-breadcrumb",
  "pane-marker-grouped",
  "pane-marker-strip-label",
  "pane-marker-app-bar",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Six of them, one
 *  per idea, continuous — this is the assertion that keeps them that way. */
const OPTIONS = [1, 2, 3, 4, 5, 6] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Pane marker ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<PaneMarkerSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 6", () => {
    const { container } = render(<PaneMarkerSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
  });

  it("shows both surfaces on every option card, so a marker cannot be judged on one alone", () => {
    render(<PaneMarkerSection />);
    // The pane's own name, from lib/pane-name.ts — once for the dashboard row and once for the
    // header, on every card. Option 4's group draws it among its three siblings.
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      const named = [...card.querySelectorAll("span")].filter(
        (el) => el.textContent === "Collie playground sync check",
      );
      expect(named.length, handle).toBeGreaterThanOrEqual(2);
    }
  });
});
