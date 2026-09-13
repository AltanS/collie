import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { IdeasSection } from "./ideas";

// The nine states this section stages, as the screenshots and any browser case address them:
// `[data-state="…"]`, the playground's one allowed handle (CLAUDE.md → "The selector rule").
const HANDLES = [
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

describe("Pane access ideas section", () => {
  it("renders every staged card under its own handle", () => {
    const { container } = render(<IdeasSection />);

    for (const handle of HANDLES) expect(cardFor(handle)).toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("the beads card rests on the bar and opens the strips in place", async () => {
    render(<IdeasSection />);
    const card = cardFor("ideas-beads-tap");

    const bar = within(card).getByRole("button", { name: /show tabs and panes/i });
    fireEvent.click(bar);

    await waitFor(() => {
      expect(within(card).getByRole("button", { name: "Hide tabs and panes" })).toBeInTheDocument();
    });
  });

  it("the breadcrumb card opens a list that leads with the blocked pane", async () => {
    render(<IdeasSection />);
    const card = cardFor("ideas-crumb-tap");

    const crumb = within(card).getByRole("button", { expanded: false });
    fireEvent.click(crumb);

    await waitFor(() => {
      expect(within(card).getByRole("button", { expanded: true })).toBeInTheDocument();
    });
    // `fix-deploy` holds the one blocked pane, so lib/triage.ts's order puts that tab's group
    // first and its blocked pane at the head of the list — the claim the card's note makes about
    // reaching the blocked pane in two taps. The rows are every button in the card except the
    // address itself, which is the one carrying `aria-expanded`.
    const first = [...card.querySelectorAll("button")].find(
      (b) => !b.hasAttribute("aria-expanded"),
    );
    expect(first?.textContent).toContain("p3");
  });

  it("the beacon is present with a blocked sibling and absent without one", () => {
    render(<IdeasSection />);

    expect(within(cardFor("ideas-beacon")).getByText("1 needs you")).toBeInTheDocument();
    expect(within(cardFor("ideas-beacon-quiet")).queryByText(/needs you/)).toBeNull();
  });

  it("mirrors the same captured screen under every idea", () => {
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
