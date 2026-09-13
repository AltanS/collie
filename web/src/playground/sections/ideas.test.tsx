import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IdeasSection } from "./ideas";

// The seven states this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "handle-today",
  "handle-on-rule",
  "handle-on-rule-peek",
  "handle-belt-pill",
  "handle-when-needed",
  "handle-when-needed-solo",
  "handle-drag-belt",
] as const;

// The strips round this section used to stage. It was the wrong target — the question was always
// the 30px pull-up handle above the composer, not the tab and pane strips above the mirror — so
// these handles must be gone rather than merely unused: a screenshot recipe or a browser case
// still naming one has to fail loudly instead of matching nothing.
const RETIRED = [
  "ideas-beads-rest",
  "ideas-beads-open",
  "ideas-beads-tap",
  "ideas-crumb-rest",
  "ideas-crumb-open",
  "ideas-crumb-tap",
  "ideas-beacon",
  "ideas-beacon-quiet",
  "ideas-autofold-closed",
  "ideas-autofold-open",
  "ideas-nested",
] as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement, so an Element found by this selector is an HTMLElement.
  return el as HTMLElement;
}

describe("Pull-up handle ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<IdeasSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("carries none of the retired strips round's handles", () => {
    render(<IdeasSection />);
    for (const gone of RETIRED) {
      expect(document.querySelector(`[data-state="${gone}"]`)).toBeNull();
    }
  });

  it("stands the real actions belt under every handle", () => {
    const { container } = render(<IdeasSection />);
    // One belt per card: six are the real ActionsRow, the seventh is the pill card's deliberate
    // copy of it, and both wear `data-slot="composer-actions"` so the count is the card count.
    const belts = [...container.querySelectorAll('[data-slot="composer-actions"]')];
    expect(belts.length).toBe(HANDLES.length - 1);
    // Keys is on every real belt, and the pill card's copy carries it too — after its own Panes
    // pill, which is the whole of that idea.
    const pillCard = cardFor("handle-belt-pill");
    const pillButtons = [...pillCard.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? "",
    );
    expect(pillButtons[0]).toBe("Panes");
    expect(pillButtons[1]).toBe("Keys");
  });

  it("shows the handle only where the idea says it should", () => {
    render(<IdeasSection />);
    // The shipped 30px band, its `Collapse`-gated twin and the grip on the rule all answer to the
    // switcher's accessible name; the solo card and the drag-the-belt card have no handle at all,
    // which is what each of them is claiming.
    for (const staged of ["handle-today", "handle-on-rule", "handle-when-needed"]) {
      expect(within(cardFor(staged)).getByRole("button", { name: "Switch pane" })).toBeInTheDocument();
    }
    for (const bare of ["handle-when-needed-solo", "handle-drag-belt"]) {
      expect(within(cardFor(bare)).queryByRole("button", { name: "Switch pane" })).toBeNull();
    }
  });

  it("peeks the real switcher sheet without opening it", () => {
    render(<IdeasSection />);
    const card = cardFor("handle-on-rule-peek");
    // A peeking BottomSheet renders its panel and its content but takes no dialog role — the sheet
    // has not opened, it is following a finger. Both halves are the claim the card's note makes.
    expect(within(card).queryByRole("dialog")).toBeNull();
    expect(within(card).getByText("Switch pane", { selector: "span" })).toBeInTheDocument();
  });

  it("mirrors the same captured screen above every idea", () => {
    const { container } = render(<IdeasSection />);
    const mirrors = [...container.querySelectorAll("pre")];
    expect(mirrors.length).toBe(HANDLES.length);
    const first = mirrors[0]?.textContent ?? "";
    expect(first.split("\n").length).toBe(8);
    for (const pre of mirrors) expect(pre.textContent).toBe(first);
    // Colour is parsed away, not left in the text — the slice is read, not rendered by AnsiOutput.
    expect(screen.queryByText(/\[3[0-9]m/)).toBeNull();
  });
});
