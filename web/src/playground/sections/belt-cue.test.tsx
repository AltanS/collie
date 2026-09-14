import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltCueSection } from "./belt-cue";

// The seven cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-cue-today",
  "belt-cue-option-1",
  "belt-cue-option-2",
  "belt-cue-option-3",
  "belt-cue-option-4",
  "belt-cue-option-5",
  "belt-cue-option-6",
] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card).
  return el as HTMLElement;
}

/** The Belt wrapper is the parent of the real ActionsRow's own marker — the div carrying the
 *  Tailwind arbitrary-variant classes under test (belt-cue.tsx's `Belt`/`BeltToday`). */
function beltWrapperFor(state: string): HTMLElement {
  const row = cardFor(state).querySelector('[data-slot="composer-actions"]');
  const wrapper = row?.parentElement;
  if (!wrapper) throw new Error(`no Belt wrapper under "${state}"`);
  // SAFETY: `Belt`/`BeltToday` render a plain <div> as the immediate parent of the ActionsRow they
  // mount, so `parentElement` here is always an HTMLDivElement.
  return wrapper as HTMLElement;
}

/** The fixed Switch cell is a SIBLING of the ActionsRow's own root, the last child of the Belt
 *  wrapper — the outer `<span>` `shadowClassName` and `leadIn`'s classes land on. */
function cellFor(state: string): HTMLElement {
  const wrapper = beltWrapperFor(state);
  const cell = wrapper.querySelector(":scope > span");
  if (!cell) throw new Error(`no fixed Switch cell under "${state}"`);
  // SAFETY: `FixedSwitchCell` renders a single outer <span>, the Belt wrapper's second and last
  // child (the ActionsRow's div is the first), so this query always finds an HTMLSpanElement.
  return cell as HTMLElement;
}

describe("Belt scroll cue section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<BeltCueSection />);
    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();
    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("mounts the real ActionsRow on every card", () => {
    render(<BeltCueSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(card.querySelectorAll('[data-slot="composer-actions"]')).toHaveLength(1);
      expect(card.querySelector('[aria-label="Keys"]')).toBeInTheDocument();
    }
  });

  it("options 2, 5 and 6 cast the cell's own shadow", () => {
    render(<BeltCueSection />);
    const CELL_SHADOW = "shadow-[-10px_0_14px_-6px_rgba(0,0,0,0.28)]";
    for (const state of ["belt-cue-option-2", "belt-cue-option-5", "belt-cue-option-6"]) {
      expect(cellFor(state).className, state).toContain(CELL_SHADOW);
    }
    for (const state of ["belt-cue-today", "belt-cue-option-1", "belt-cue-option-3", "belt-cue-option-4"]) {
      expect(cellFor(state).className, state).not.toContain(CELL_SHADOW);
    }
  });

  it("option 3 alone paints the track's own inset shadow", () => {
    render(<BeltCueSection />);
    const INSET = "[&_[data-overflow]]:shadow-[inset_-14px_0_12px_-10px_rgba(0,0,0,0.22)]";
    expect(beltWrapperFor("belt-cue-option-3").className).toContain(INSET);
    for (const state of HANDLES.filter((h) => h !== "belt-cue-option-3")) {
      expect(beltWrapperFor(state).className, state).not.toContain(INSET);
    }
  });

  it("option 4 alone frosts the cell with a backdrop blur", () => {
    render(<BeltCueSection />);
    // The blur sits on the cell's own INNER masked span (its first child), not its outer span
    // (`shadowClassName`'s own home) — see `FixedSwitchCell` in belt-cue.tsx.
    for (const state of HANDLES) {
      const inner = cellFor(state).querySelector(':scope > span[aria-hidden]');
      const blurred = inner?.className.includes("backdrop-blur-[3px]") ?? false;
      expect(blurred, state).toBe(state === "belt-cue-option-4");
    }
  });
});
