import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostTagSection } from "./host-tag";

// The five states this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "host-today",
  "host-on-input",
  "host-in-placeholder",
  "host-under-send",
  "host-on-send",
] as const;

/** Every card but the shipped one. These are the four roads not taken, and each of them must have
 *  taken the name out of the belt entirely. */
const OPTIONS = HANDLES.filter((h) => h !== "host-today");

/** The chip's own accessible name on a write surface (`connection.host.ariaSends`), which is how a
 *  test finds the tag without reaching for a class string. */
const TAG_LABEL = "Sends to host: lodge";

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement.
  return el as HTMLElement;
}

/** The belt inside one card, which is the element the whole round is about. */
function beltIn(card: HTMLElement): HTMLElement {
  const belt = card.querySelector('[data-slot="composer-actions"]');
  if (!belt) throw new Error(`no belt in ${card.getAttribute("data-state")}`);
  // SAFETY: `data-slot="composer-actions"` is set on a plain <div> by ActionsRow, never on an SVG or
  // other non-HTMLElement, so an Element found by this selector is an HTMLElement.
  return belt as HTMLElement;
}

describe("Host tag ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<HostTagSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("stands the real belt over the real input row on every card", () => {
    render(<HostTagSection />);
    for (const handle of HANDLES) {
      const card = cardFor(handle);
      expect(beltIn(card)).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Send" })).toBeInTheDocument();
      expect(card.querySelector('[data-slot="chat-input"]')).toBeInTheDocument();
    }
  });

  it("pins the Switch pill on the shipped card, out of the scroller, and the tag on no belt at all", () => {
    render(<HostTagSection />);
    // The belt's pinned slot holds the pane switcher now, not the machine. This card draws the real
    // ActionsRow, so the claim is checked against the app rather than against a mock.
    const shipped = beltIn(cardFor("host-today"));
    const pill = within(shipped).getByRole("button", { name: "Switch pane" });
    expect(shipped.querySelector(".overflow-x-auto")!.contains(pill)).toBe(false);
    // The machine is on NO belt any more — not the shipped one, and not on any road not taken,
    // each of which put the name somewhere else entirely, which is what made it an option.
    for (const handle of HANDLES) {
      expect(within(beltIn(cardFor(handle))).queryByLabelText(TAG_LABEL)).toBeNull();
    }
  });

  it("names the machine somewhere on every road not taken", () => {
    render(<HostTagSection />);
    // Each of the four draws the name itself, in the field's placeholder or in a span of its own,
    // so the card's own text is the assertion that holds for all of them.
    for (const option of OPTIONS) {
      const card = cardFor(option);
      const drawn = card.querySelector('[data-slot="chat-input"]')?.getAttribute("placeholder") ?? "";
      const spans = [...card.querySelectorAll("span")].some((s) => s.textContent === "lodge");
      expect(spans || drawn.includes("lodge")).toBe(true);
    }
  });
});
