import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltEdgeSection } from "./belt-edge";

// The seven cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-edge-today",
  "belt-edge-option-1",
  "belt-edge-option-2",
  "belt-edge-option-3",
  "belt-edge-option-4",
  "belt-edge-option-5",
  "belt-edge-option-6",
] as const;

/** The Belt wrapper is the parent of the real ActionsRow's own marker — the div carrying the
 *  Tailwind arbitrary-variant classes under test. */
function beltWrapperFor(state: string): HTMLElement {
  const card = document.querySelector(`[data-state="${state}"]`);
  if (!card) throw new Error(`no card with data-state="${state}"`);
  const row = card.querySelector('[data-slot="composer-actions"]');
  const wrapper = row?.parentElement;
  if (!wrapper) throw new Error(`no Belt wrapper under "${state}"`);
  // SAFETY: `Belt` (belt-edge.tsx) renders a plain <div> as the immediate parent of the ActionsRow
  // it mounts, so `parentElement` here is always an HTMLDivElement, never an SVG or text node.
  return wrapper as HTMLElement;
}

/** How many ground-colour layers the fixed Switch cell stacks under its one mask: 2 when
 *  `leadInGround` draws its own top layer (the default), 1 when it is `"none"` (option 4 alone). */
function groundLayerCount(state: string): number {
  const wrapper = beltWrapperFor(state);
  const cellMask = wrapper.querySelector(":scope > span > span[aria-hidden]");
  return cellMask?.querySelectorAll(":scope > span").length ?? -1;
}

describe("Belt scroller edge section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<BeltEdgeSection />);
    for (const handle of HANDLES) expect(document.querySelector(`[data-state="${handle}"]`)).toBeInTheDocument();
    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("mounts the real ActionsRow on every card", () => {
    render(<BeltEdgeSection />);
    for (const handle of HANDLES) {
      const card = document.querySelector(`[data-state="${handle}"]`);
      expect(card?.querySelectorAll('[data-slot="composer-actions"]')).toHaveLength(1);
      // A general action's own accessible name, present on every card.
      expect(card?.querySelector('[aria-label="Keys"]')).toBeInTheDocument();
    }
  });

  it("options 1, 4 and 6 clear the left mask; option 5 dims it instead", () => {
    render(<BeltEdgeSection />);
    for (const state of ["belt-edge-option-1", "belt-edge-option-4", "belt-edge-option-6"]) {
      expect(beltWrapperFor(state).className).toContain("[&_[data-overflow]>div]:[mask-image:none]");
    }
    const option5 = beltWrapperFor("belt-edge-option-5").className;
    expect(option5).not.toContain("[&_[data-overflow]>div]:[mask-image:none]");
    expect(option5).toContain(
      "[&_[data-overflow]>div]:[mask-image:linear-gradient(to_right,black_calc(100%-6.5rem),rgba(0,0,0,0.35)_calc(100%-4.5rem),rgba(0,0,0,0.35))]",
    );
  });

  it("option 2 shortens the left mask to 0.75rem", () => {
    render(<BeltEdgeSection />);
    expect(beltWrapperFor("belt-edge-option-2").className).toContain(
      "[&_[data-overflow]>div]:[mask-image:linear-gradient(to_right,transparent,black_0.75rem)]",
    );
  });

  it("options 1, 4 and 5 no longer paint the same picture", () => {
    render(<BeltEdgeSection />);
    // Option 4 drops the fixed cell's top ground layer (leadInGround="none"), so it stacks one
    // fewer layer than option 1's default — the visible difference: plain band vs. solid chrome.
    expect(groundLayerCount("belt-edge-option-1")).toBe(2);
    expect(groundLayerCount("belt-edge-option-4")).toBe(1);
    // Option 1 and option 4 share the same wrapper classes (both just clear the left mask) — their
    // difference is entirely in the fixed cell, asserted above. Option 5's wrapper classes differ
    // from both: the tint moves to the outer wrapper and the left mask dims rather than clears.
    const classes1 = beltWrapperFor("belt-edge-option-1").className;
    const classes4 = beltWrapperFor("belt-edge-option-4").className;
    const classes5 = beltWrapperFor("belt-edge-option-5").className;
    expect(classes1).not.toBe(classes5);
    expect(classes4).not.toBe(classes5);
    expect(classes4).not.toContain("[&_[data-overflow]]:bg-primary/10");
    expect(classes5).toContain("[&_[data-overflow]]:bg-primary/10");
  });
});
