import { act, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { COLLAPSE_MS } from "./collapse";
import { Notice } from "./notice";
import { StripHost, StripSlot } from "./strip-host";

/** The layer wrapper the host paints a registered strip in. One per registered slot. */
function layers(container: HTMLElement) {
  return [...container.querySelectorAll("[class*='grid-area']")];
}

describe("StripHost — the top band, one winner", () => {
  it("shows only the highest priority when several slots are mounted", () => {
    // Four strips can be true at once today and none excludes another; two of them cost ~66px of a
    // 390x844 phone and double the number of times the page moves. Every pair has a strict "which
    // matters more" answer, so the band arbitrates instead of stacking.
    const { container } = render(
      <StripHost>
        <StripSlot priority={10}>
          <Notice tone="info" variant="strip">
            A new version is ready
          </Notice>
        </StripSlot>
        <StripSlot priority={40}>
          <Notice tone="danger" variant="strip">
            Signed out
          </Notice>
        </StripSlot>
        <StripSlot priority={20}>
          <Notice tone="caution" variant="strip">
            Reconnecting…
          </Notice>
        </StripSlot>
        <div>route</div>
      </StripHost>,
    );

    const front = layers(container).filter((l) => l.className.includes("opacity-100"));
    expect(front).toHaveLength(1);
    expect(front[0]).toHaveTextContent("Signed out");

    // The losers are painted-out rather than removed, so the band has a fixed set of stacked
    // layers and a swap cannot change its height even for one frame. `inert` because a fading
    // strip may still hold a focusable Retry: hiding a focusable thing from the accessibility tree
    // without taking it out of the tab order is the worse of the two bugs.
    for (const loser of layers(container).filter((l) => !l.className.includes("opacity-100"))) {
      expect(loser).toHaveClass("opacity-0", "pointer-events-none");
      expect(loser).toHaveAttribute("inert");
    }
  });

  it("hands the band over without re-animating its height", () => {
    // Replacement is a dissolve INSIDE the already-open Collapse. All the layers share one grid
    // cell, so the row is as tall as the tallest of them at every instant — and every strip sits on
    // the same min-h-[33px] floor, so they are all the same. The height animates on appear and on
    // leave, and at no other time.
    const { container } = render(
      <StripHost>
        <StripSlot priority={20}>
          <Notice tone="caution" variant="strip">
            Reconnecting…
          </Notice>
        </StripSlot>
        <StripSlot priority={30}>
          <Notice tone="danger" variant="strip">
            No connection
          </Notice>
        </StripSlot>
      </StripHost>,
    );
    const cell = layers(container);
    expect(cell.length).toBeGreaterThan(1);
    // One cell: same row, same column, for all of them.
    expect(new Set(cell.map((l) => /\[grid-area:[^\]]+\]/.exec(l.className)?.[0])).size).toBe(1);
    expect(cell[0]).toHaveClass("transition-opacity");
    expect(cell[0]?.className).toMatch(/duration-\[120ms\]/);
  });

  it("keeps its live regions mounted before there is anything to announce", () => {
    // A live region has to be in the document BEFORE its contents change, or the change is not
    // reliably announced — mounting a role="alert" and its text in the same commit is the classic
    // way to ship a banner no screen reader ever reads. These two are the band's permanent anchors.
    const { container } = render(
      <StripHost>
        <div>route</div>
      </StripHost>,
    );
    const polite = container.querySelector('[data-slot="strip-live-polite"]');
    const assertive = container.querySelector('[data-slot="strip-live-assertive"]');
    expect(polite).toHaveAttribute("role", "status");
    expect(assertive).toHaveAttribute("role", "alert");
    expect(polite).toHaveClass("sr-only");
    // A role and nothing else. role="status" already means polite and role="alert" already means
    // assertive; writing an aria-live beside either asks one question twice.
    expect(polite).not.toHaveAttribute("aria-live");
    expect(assertive).not.toHaveAttribute("aria-live");
    // And they are there with no strip registered at all.
    expect(layers(container)).toHaveLength(0);
  });

  it("reserves no safe-area inset, and neither does any strip in it", () => {
    // The band paints UNDER the header since 2026-10-07, so it is never the first thing on the
    // screen and the notch is never its to clear. The header owns the inset in every state
    // (`app-header.tsx`); a reservation here would pay for the notch twice while a strip shows.
    const { container } = render(
      <StripHost>
        <StripSlot priority={10}>
          <Notice tone="info" variant="strip">
            copy
          </Notice>
        </StripSlot>
      </StripHost>,
    );
    expect(layers(container)).toHaveLength(1);
    expect(container.querySelectorAll("[class*='safe-area-inset-top']")).toHaveLength(0);
    expect(screen.getByText("copy").className).not.toMatch(/safe-area/);
  });

  it("paints the band BEFORE its children, which is what puts it between the header and the route", () => {
    // `routes/root.tsx` mounts this host inside the header host, around the outlet. The band then
    // comes after the header (the header host renders its bar first) and before the route (this
    // host renders the band first), so the ribbon sits under the bar and above the screen.
    render(
      <StripHost>
        <StripSlot priority={10}>
          <Notice tone="info" variant="strip">
            copy
          </Notice>
        </StripSlot>
        <main>route</main>
      </StripHost>,
    );
    const strip = screen.getByText("copy");
    const route = screen.getByText("route");
    expect(strip.compareDocumentPosition(route) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps painting the last strip while the band collapses", () => {
    // Without this the content disappears the instant the condition clears and the Collapse
    // animates an empty box — the exit reads as a blink followed by a slide, instead of the strip
    // sliding away. The same thing connection-banner does today with its shownToneRef.
    vi.useFakeTimers();
    const { container, rerender } = render(
      <StripHost>
        <StripSlot priority={30}>
          <Notice tone="danger" variant="strip">
            No connection
          </Notice>
        </StripSlot>
      </StripHost>,
    );
    rerender(
      <StripHost>
        <div>route</div>
      </StripHost>,
    );
    expect(screen.getByText("No connection")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(COLLAPSE_MS + 1);
    });
    expect(screen.queryByText("No connection")).toBeNull();
    expect(layers(container)).toHaveLength(0);
    vi.useRealTimers();
  });

  it("renders nothing where a slot sits, and paints nothing without a host", () => {
    // The feature component stays next to the state machine that decides its condition; the pixels
    // appear in the one band that arbitrates them. Outside a host a slot is silent rather than
    // fatal: a strip is chrome, and a route that forgot the host should be missing a banner, not
    // blank.
    const { container } = render(
      <div>
        <StripSlot priority={10}>
          <Notice tone="info" variant="strip">
            orphan
          </Notice>
        </StripSlot>
      </div>,
    );
    expect(container.textContent).toBe("");
  });

  it("breaks a priority tie by registration order, deterministically", () => {
    const { container } = render(
      <StripHost>
        <StripSlot priority={20}>
          <Notice tone="caution" variant="strip">
            first
          </Notice>
        </StripSlot>
        <StripSlot priority={20}>
          <Notice tone="caution" variant="strip">
            second
          </Notice>
        </StripSlot>
      </StripHost>,
    );
    const front = layers(container).filter((l) => l.className.includes("opacity-100"));
    expect(front).toHaveLength(1);
    expect(front[0]).toHaveTextContent("first");
  });
});
