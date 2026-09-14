import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BeltCapsuleSection } from "./belt-capsule";

// The nine cards this section stages: `[data-state="…"]`, the playground's one allowed handle
// (CLAUDE.md → "The selector rule").
const HANDLES = [
  "belt-capsule-today",
  "belt-capsule-option-1",
  "belt-capsule-option-2",
  "belt-capsule-option-3",
  "belt-capsule-option-4",
  "belt-capsule-option-5",
  "belt-capsule-option-6",
  "belt-capsule-option-7",
  "belt-capsule-option-8",
] as const;

const OPTIONS = HANDLES.filter((h) => h !== "belt-capsule-today");

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card).
  return el as HTMLElement;
}

/** The Belt wrapper is the GRANDPARENT of the real ActionsRow's own marker — belt-capsule.tsx's
 *  `Belt` wraps `ActionsRow` in its own `min-w-0 flex-1` div first, so the wrapper carrying the
 *  Tailwind arbitrary-variant classes under test is one level further up than in belt-edge.tsx. */
function beltWrapperFor(state: string): HTMLElement {
  const row = cardFor(state).querySelector('[data-slot="composer-actions"]');
  const wrapper = row?.parentElement?.parentElement;
  if (!wrapper) throw new Error(`no Belt wrapper under "${state}"`);
  // SAFETY: `Belt` (belt-capsule.tsx) renders two plain <div>s above the ActionsRow it mounts
  // (the flex-1 wrapper, then the Belt wrapper itself), so `parentElement.parentElement` here is
  // always an HTMLDivElement.
  return wrapper as HTMLElement;
}

describe("Belt capsule section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<BeltCapsuleSection />);
    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();
    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
  });

  it("mounts the real ActionsRow on every card", () => {
    render(<BeltCapsuleSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(card.querySelectorAll('[data-slot="composer-actions"]')).toHaveLength(1);
      expect(card.querySelector('[aria-label="Keys"]')).toBeInTheDocument();
    }
  });

  it("options 1 to 8 clip the scroller, clear its mask, and drop its vertical padding", () => {
    render(<BeltCapsuleSection />);
    for (const state of OPTIONS) {
      const classes = beltWrapperFor(state).className;
      expect(classes, state).toContain("[&_[data-overflow]>div]:[mask-image:none]");
      expect(classes, state).toContain("[&_[data-overflow]]:overflow-hidden");
      // COMPACT_TRACK, applied to every option via Belt's own base classes.
      expect(classes, state).toContain("[&_[data-overflow]>div>div]:py-0");
    }
  });

  it("options 7 and 8 shrink the pills to 28px; the rest keep the shipped 32px", () => {
    render(<BeltCapsuleSection />);
    const PILL_HEIGHT = "[&_[data-overflow]_button]:h-7";
    for (const state of ["belt-capsule-option-7", "belt-capsule-option-8"]) {
      expect(beltWrapperFor(state).className).toContain(PILL_HEIGHT);
    }
    for (const state of OPTIONS.filter((s) => !["belt-capsule-option-7", "belt-capsule-option-8"].includes(s))) {
      expect(beltWrapperFor(state).className).not.toContain(PILL_HEIGHT);
    }
  });

  it("option 8 alone drops the wrapper's bottom padding and the input row's top padding", () => {
    render(<BeltCapsuleSection />);
    expect(beltWrapperFor("belt-capsule-option-8").className).toContain("pb-0");
    for (const state of OPTIONS.filter((s) => s !== "belt-capsule-option-8")) {
      expect(beltWrapperFor(state).className).not.toContain("pb-0");
    }
  });

  it("option 3 alone outlines the capsule itself", () => {
    render(<BeltCapsuleSection />);
    // Option 5 also carries `border-border` (its surviving band's own hairline underneath it), so
    // the assertion targets the CAPSULE's own outline selector specifically, not the substring.
    const CAPSULE_OUTLINE = "[&_[data-overflow]]:border-border";
    expect(beltWrapperFor("belt-capsule-option-3").className).toContain(CAPSULE_OUTLINE);
    for (const state of OPTIONS.filter((s) => s !== "belt-capsule-option-3")) {
      expect(beltWrapperFor(state).className).not.toContain(CAPSULE_OUTLINE);
    }
  });

  it("options 1 to 8 float the Switch mark outside the ActionsRow", () => {
    render(<BeltCapsuleSection />);
    for (const state of OPTIONS) {
      const mark = cardFor(state).querySelector("svg.lucide-layers");
      expect(mark, state).toBeTruthy();
      expect(mark?.closest('[data-slot="composer-actions"]'), state).toBeNull();
    }
  });
});
