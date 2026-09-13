import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HostTagSection } from "./host-tag";

// The six states this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
  "host-today",
  "host-on-input",
  "host-in-placeholder",
  "host-under-send",
  "host-on-send",
  "host-belt-end",
] as const;

/** Every card but the baseline. These are the five that must have taken the tag out of the belt. */
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

  it("keeps the tag in the belt on the baseline card only", () => {
    render(<HostTagSection />);
    // The crew is real, so the chip's hide rule is satisfied and the shipped tag is really there.
    expect(within(beltIn(cardFor("host-today"))).getByLabelText(TAG_LABEL)).toBeInTheDocument();
    // Every option takes it out of the scroller, which is the whole claim each of them makes.
    for (const option of OPTIONS) {
      expect(within(beltIn(cardFor(option))).queryByLabelText(TAG_LABEL)).toBeNull();
    }
  });

  it("names the machine somewhere on every option card", () => {
    render(<HostTagSection />);
    // The belt-end idea keeps the REAL chip, pinned outside the scroller; the other four draw the
    // name themselves, so the card's text is the assertion that holds for all five.
    for (const option of OPTIONS) {
      const card = cardFor(option);
      const drawn = card.querySelector('[data-slot="chat-input"]')?.getAttribute("placeholder") ?? "";
      const pinned = within(card).queryAllByLabelText(TAG_LABEL).length > 0;
      const spans = [...card.querySelectorAll("span")].some((s) => s.textContent === "lodge");
      expect(pinned || spans || drawn.includes("lodge")).toBe(true);
    }
    expect(within(cardFor("host-belt-end")).getByLabelText(TAG_LABEL)).toBeInTheDocument();
  });
});
