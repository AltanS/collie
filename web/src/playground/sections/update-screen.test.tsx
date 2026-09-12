import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { clearStatus } from "@/lib/status";
import { UpdateScreenSection } from "./update-screen";

// The Update screen tab of the playground. Altan reviews UI here, so the cards have to be real: the
// real component, the real reducer, and a stable `data-state` handle per state. This file proves all
// thirteen render, that each one carries its handle, and that the handles are unique and flat-kebab —
// the same three rules `app.test.tsx` applies across every section, asserted here against the count
// the milestone names.

/** Every state the milestone asks for, in the order the section shows them. */
const HANDLES = [
  "collapsed",
  "expanded-preflight",
  "expanded-staging",
  "expanded-restarting",
  "expanded-verifying",
  "peer-unreachable",
  "peer-rolled-back",
  "download-files",
  "download-hung",
  "lead-stalled",
  "stuck",
  "done-toast",
  "done-toast-solo",
] as const;

afterEach(() => clearStatus());

describe("the Update screen playground section", () => {
  it("renders a card for every state, with no error boundary", () => {
    const { container } = render(<UpdateScreenSection />);
    expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    const handles = cards.map((card) => card.getAttribute("data-state") ?? "");
    expect(handles).toHaveLength(HANDLES.length);
    expect(new Set(handles).size).toBe(handles.length);
    for (const handle of handles) expect(handle).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(handles.toSorted()).toEqual([...HANDLES].toSorted());
  });

  it("shows a real dialog in the expanded cards and a real badge in the collapsed one", () => {
    const { container } = render(<UpdateScreenSection />);
    const card = (handle: string): HTMLElement => {
      const el = container.querySelector(`[data-state="${handle}"]`);
      if (!el) throw new Error(`no card with data-state="${handle}"`);
      // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
      // never an SVG or other non-HTMLElement.
      return el as HTMLElement;
    };

    expect(within(card("expanded-staging")).getByRole("dialog")).toBeInTheDocument();
    // The badge is NOT a dialog: the device that did not start the run is not taken over.
    expect(within(card("collapsed")).queryByRole("dialog")).toBeNull();
    expect(within(card("collapsed")).getByRole("button")).toBeInTheDocument();
  });

  it("counts files in the download card, and says so in the hung one", () => {
    const { container } = render(<UpdateScreenSection />);
    const files = container.querySelector('[data-state="download-files"]');
    expect(files?.textContent).toMatch(/12 of 28 files/);
    const hung = container.querySelector('[data-state="download-hung"]');
    expect(hung?.textContent).toMatch(/Still downloading/);
  });

  it("the two end cards carry the reducer's own sentence, crew and solo apart", () => {
    const { container } = render(<UpdateScreenSection />);
    // The sheet is HIDDEN in both — the end is announced, not presented — so the card's own control
    // is what publishes the real sentence through the real status channel.
    const crew = container.querySelector('[data-state="done-toast"]');
    const solo = container.querySelector('[data-state="done-toast-solo"]');
    expect(crew?.querySelector('[role="dialog"]')).toBeNull();
    expect(solo?.querySelector('[role="dialog"]')).toBeNull();
    expect(crew?.textContent).toMatch(/crew/i);
    expect(solo?.textContent).toMatch(/machine/i);
  });
});
