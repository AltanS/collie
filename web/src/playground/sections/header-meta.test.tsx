import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeaderMetaSection } from "./header-meta";

// The five cards this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "header-meta-third-line",
  "header-meta-host-when-other",
  "header-meta-host-dot",
  "header-meta-quiet",
  "header-meta-under-kebab",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Five of them, one
 *  per idea — this is the assertion that keeps them that way. */
const OPTIONS = [1, 2, 3, 4, 5] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Pane header meta ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<HeaderMetaSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 5", () => {
    const { container } = render(<HeaderMetaSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
  });
});
