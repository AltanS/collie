import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeaderCornerSection } from "./header-corner";

// The ten cards this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "header-corner-today",
  "header-corner-fused",
  "header-corner-path-meta",
  "header-corner-two-bare",
  "header-corner-tab-cache",
  "header-corner-host-crumb",
  "header-corner-kebab-menu",
  "switch-pill-icon",
  "switch-pill-bare",
  "switch-pill-chevron",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Nine of them, one
 *  per idea, continuous across both groups — this is the assertion that keeps them that way. */
const OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Header corner ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<HeaderCornerSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 9", () => {
    const { container } = render(<HeaderCornerSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
  });

  it("gives every Switch option an accessible name, now that the word is gone", () => {
    render(<HeaderCornerSection />);
    // Option 8 shipped, so its card hands the REAL ActionsRow a handle and the real one announces
    // "Switch pane" — the app's own string, not this page's. The two ideas beside it are still drawn
    // here and name themselves.
    const named = {
      "switch-pill-icon": "Switch",
      "switch-pill-bare": "Switch pane",
      "switch-pill-chevron": "Switch",
    } as const;
    for (const [handle, name] of Object.entries(named)) {
      const card = cardFor(handle);
      const button = card.querySelector(`button[aria-label="${name}"]`);
      expect(button, handle).not.toBeNull();
      expect(button?.textContent).toBe("");
    }
  });
});
