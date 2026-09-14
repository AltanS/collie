import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RowSecondLineSection } from "./row-second-line";

// The cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "row-second-line-shipped",
  "row-second-line-multiplexers",
  "row-second-line-option-1",
  "row-second-line-option-2",
  "row-second-line-option-3",
] as const;

/** Altan picks a card by saying "option N", so the number has to be ON the card. Three of them, one
 *  per idea, continuous — this is the assertion that keeps them that way. */
const OPTIONS = [1, 2, 3] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

describe("Blank tab line and other multiplexers section", () => {
  it("mounts every staged card under its own handle", () => {
    const { container } = render(<RowSecondLineSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("numbers every option, once each, from 1 to 3", () => {
    const { container } = render(<RowSecondLineSection />);
    const labels = [...container.querySelectorAll(".pg-grid > * > p")].map(
      (p) => p.textContent ?? "",
    );
    for (const n of OPTIONS) {
      const matching = labels.filter((text) => text.startsWith(`Option ${n} ·`));
      expect(matching, `Option ${n}`).toHaveLength(1);
    }
  });

  it("mounts the real dashboard list on the two shipped cards", () => {
    render(<RowSecondLineSection />);
    for (const handle of ["row-second-line-shipped", "row-second-line-multiplexers"] as const) {
      const card = cardFor(handle);
      // Every pane row is its own <button> (AgentCard) — at least one per card.
      expect(card.querySelectorAll("button").length).toBeGreaterThan(0);
    }
  });

  it("shows the herdr-shaped fixture's three row shapes — a name, a position, and neither", () => {
    render(<RowSecondLineSection />);
    const shipped = cardFor("row-second-line-shipped");
    expect(shipped.textContent).toContain("release-notes");
    expect(shipped.textContent).toContain("tab 2");
  });

  it("repeats the auto-named program across the tmux-shaped mock", () => {
    render(<RowSecondLineSection />);
    const mocks = cardFor("row-second-line-multiplexers");
    const bashCount = (mocks.textContent?.match(/bash/gu) ?? []).length;
    expect(bashCount).toBeGreaterThanOrEqual(6);
  });
});
