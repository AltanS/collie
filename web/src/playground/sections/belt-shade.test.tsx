import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltShadeSection } from "./belt-shade";

// The nine cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-shade-today",
  "belt-shade-option-1",
  "belt-shade-option-2",
  "belt-shade-option-3",
  "belt-shade-option-4",
  "belt-shade-option-5",
  "belt-shade-option-6",
  "belt-shade-option-7",
  "belt-shade-option-8",
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

/** The cell's own inner masked span carries `leadIn.mask` — the first child of {@link cellFor}. */
function maskFor(state: string): HTMLElement {
  const inner = cellFor(state).querySelector(':scope > span[aria-hidden]');
  if (!inner) throw new Error(`no masked span under "${state}"`);
  // SAFETY: `FixedSwitchCell` renders its masked backdrop as a single <span aria-hidden>, the
  // first child of the cell's outer <span>, so this query always finds an HTMLSpanElement.
  return inner as HTMLElement;
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

  it("options 1, 2, 3 and 7 carry their own distinct fade mask", () => {
    render(<BeltShadeSection />);
    const expected = {
      "belt-shade-option-1": "[mask-image:linear-gradient(to_right,transparent,black_1rem)]",
      "belt-shade-option-2": "[mask-image:linear-gradient(to_right,transparent,black_3rem)]",
      "belt-shade-option-3":
        "[mask-image:linear-gradient(to_right,transparent,rgba(0,0,0,0.25)_45%,black_2rem)]",
      "belt-shade-option-7": "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
    } satisfies Record<string, string>;
    for (const [state, mask] of Object.entries(expected)) {
      expect(maskFor(state).className, state).toContain(mask);
    }
    // Every one of the four is a genuinely different string from the shipped 32px fade.
    const shipped = "[mask-image:linear-gradient(to_right,transparent,black_2rem)]";
    for (const state of Object.keys(expected)) {
      expect(maskFor(state).className, state).not.toContain(shipped);
    }
  });

  it("option 6 alone carries the draining-tint gradient on the track wrapper", () => {
    render(<BeltShadeSection />);
    const GRADIENT =
      "[&_[data-overflow]]:bg-[linear-gradient(to_right,color-mix(in_oklab,var(--color-primary)_10%,transparent)_calc(100%-6rem),transparent_calc(100%-2rem))]";
    expect(beltWrapperFor("belt-shade-option-6").className).toContain(GRADIENT);
    for (const state of HANDLES.filter((h) => h !== "belt-shade-option-6")) {
      expect(beltWrapperFor(state).className, state).not.toContain(GRADIENT);
    }
  });
});
