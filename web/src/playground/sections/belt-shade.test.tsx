import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltShadeSection } from "./belt-shade";

// The seven cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-shade-today",
  "belt-shade-option-1",
  "belt-shade-option-2",
  "belt-shade-option-3",
  "belt-shade-option-4",
  "belt-shade-option-5",
  "belt-shade-option-6",
] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card).
  return el as HTMLElement;
}

/** The Belt wrapper is the parent of the real ActionsRow's own marker — the div carrying the
 *  Tailwind arbitrary-variant classes under test (belt-shade.tsx's `Belt`). */
function beltWrapperFor(state: string): HTMLElement {
  const row = cardFor(state).querySelector('[data-slot="composer-actions"]');
  const wrapper = row?.parentElement;
  if (!wrapper) throw new Error(`no Belt wrapper under "${state}"`);
  // SAFETY: `Belt` renders a plain <div> as the immediate parent of the ActionsRow it mounts, so
  // `parentElement` here is always an HTMLDivElement.
  return wrapper as HTMLElement;
}

/** The fixed Switch cell is a SIBLING of the ActionsRow's own root, the last child of the Belt
 *  wrapper — the outer `<span>` `leadIn.pl`'s class lands on. */
function cellFor(state: string): HTMLElement {
  const wrapper = beltWrapperFor(state);
  const cell = wrapper.querySelector(":scope > span");
  if (!cell) throw new Error(`no fixed Switch cell under "${state}"`);
  // SAFETY: `FixedSwitchCell` renders a single outer <span>, the Belt wrapper's second and last
  // child (the ActionsRow's div is the first), so this query always finds an HTMLSpanElement.
  return cell as HTMLElement;
}

/** The Switch mark's own pill, the last of the two spans inside the cell's "self-stretch" wrapper
 *  (the hairline is the first) — `switchWidth`'s own home. */
function switchButtonFor(state: string): HTMLElement {
  const button = cellFor(state).querySelector(":scope > span:last-child > span:last-child");
  if (!button) throw new Error(`no Switch button under "${state}"`);
  // SAFETY: `FixedSwitchCell`'s "self-stretch" wrapper (the cell's own last direct child) always
  // renders exactly two spans, the hairline then the pill, so its last child is always the pill.
  return button as HTMLElement;
}

describe("Belt shade section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<BeltShadeSection />);
    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();
    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("mounts the real ActionsRow on every card", () => {
    render(<BeltShadeSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(card.querySelectorAll('[data-slot="composer-actions"]')).toHaveLength(1);
      expect(card.querySelector('[aria-label="Keys"]')).toBeInTheDocument();
    }
  });

  it("every card fixes the vertical-scroll bug COMPACT introduces", () => {
    render(<BeltShadeSection />);
    for (const state of HANDLES) {
      expect(beltWrapperFor(state).className, state).toContain(
        "[&_[data-overflow]>div>div]:overflow-y-hidden",
      );
    }
  });

  it("narrows the Switch mark per card, and leaves today's alone", () => {
    render(<BeltShadeSection />);
    const expected = {
      "belt-shade-today": "min-w-11",
      "belt-shade-option-1": "min-w-9",
      "belt-shade-option-2": "min-w-9",
      "belt-shade-option-3": "min-w-9",
      "belt-shade-option-4": "min-w-9",
      "belt-shade-option-5": "min-w-8",
      "belt-shade-option-6": "min-w-8",
    } satisfies Record<string, string>;
    for (const [state, floor] of Object.entries(expected)) {
      expect(switchButtonFor(state).className, state).toContain(floor);
    }
    // "As today" alone keeps the shipped 44px width, distinct from every narrowed card.
    expect(switchButtonFor("belt-shade-today").className).not.toContain("min-w-9");
    expect(switchButtonFor("belt-shade-today").className).not.toContain("min-w-8");
  });
});
