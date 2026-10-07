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
    // The band hangs UNDER the header since 2026-10-07, so it is never the first thing on the
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

  it("paints the band BEFORE its children, which is what hangs it from the header's bottom edge", () => {
    // `routes/root.tsx` mounts this host inside the header host, around the outlet. The anchor then
    // comes right after the header (the header host renders its bar first) and before the route
    // (this host renders the anchor first), so the band hangs from the bar's bottom edge, over the
    // top of the route.
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

  it("hangs the band as an overlay from a zero-height anchor, so it reserves no space", () => {
    // 2026-10-07: an outage shoved the pane strip down, and the operator does not want layout
    // shifts. The band covers whatever sits under the header instead. jsdom cannot measure, so the
    // contract is asserted as classes: the anchor is in flow at zero height and owns the rung, and
    // the band is absolutely positioned from its top edge with the page colour and a shadow.
    const { container } = render(
      <StripHost>
        <StripSlot priority={10}>
          <Notice tone="danger" variant="strip">
            copy
          </Notice>
        </StripSlot>
        <main>route</main>
      </StripHost>,
    );
    const anchor = container.querySelector('[data-slot="strip-anchor"]');
    expect(anchor).toHaveClass("relative", "z-30", "h-0", "shrink-0");
    expect(anchor).toHaveAttribute("data-placement", "overlay");
    const band = anchor?.querySelector(':scope > [data-slot="collapse"]');
    expect(band).toHaveClass("absolute", "inset-x-0", "top-0", "bg-background", "shadow-md");
    expect(band).toContainElement(screen.getByText("copy"));
    // The route is the anchor's next sibling, not its child, so nothing it lays out depends on the band.
    expect(anchor).not.toContainElement(screen.getByText("route"));
  });

  it("leaves the route's box untouched whether or not a strip is registered", () => {
    // The route must not reserve, pad or offset anything for the band. Render the same tree with and
    // without a strip: the route's wrapper and the anchor are byte-for-byte the same element both times.
    const route = (
      <div data-slot="route" className="flex min-h-0 flex-1 flex-col">
        route
      </div>
    );
    const bare = render(<StripHost>{route}</StripHost>);
    const bareRoute = bare.container.querySelector('[data-slot="route"]')?.outerHTML;
    const bareAnchorClass = bare.container.querySelector('[data-slot="strip-anchor"]')?.className;
    bare.unmount();

    const withStrip = render(
      <StripHost>
        <StripSlot priority={10}>
          <Notice tone="danger" variant="strip">
            copy
          </Notice>
        </StripSlot>
        {route}
      </StripHost>,
    );
    expect(withStrip.container.querySelector('[data-slot="route"]')?.outerHTML).toBe(bareRoute);
    expect(withStrip.container.querySelector('[data-slot="strip-anchor"]')?.className).toBe(bareAnchorClass);
    expect(bareRoute).not.toMatch(/\b(?:p|pt|m|mt)-|safe-area/);
  });

  it("casts no shadow while the band is empty", () => {
    // The surface lives on the Collapse, which only exists while a strip is rendered, so an empty
    // anchor paints nothing at all: no page-colour slab, no shadow line under the header.
    const { container } = render(
      <StripHost>
        <main>route</main>
      </StripHost>,
    );
    const anchor = container.querySelector('[data-slot="strip-anchor"]');
    expect(anchor).toBeInTheDocument();
    expect(anchor?.children).toHaveLength(0);
    expect(container.querySelector(".shadow-md")).toBeNull();
  });

  it("paints the band in flow, with no overlay classes, only when a stage asks for it", () => {
    // The playground's single-strip cards have no route under the band, so an overlay would hang
    // outside their clipped box. `flow` is their escape, and the app never sets it.
    const { container } = render(
      <StripHost flow>
        <StripSlot priority={10}>
          <Notice tone="info" variant="strip">
            copy
          </Notice>
        </StripSlot>
      </StripHost>,
    );
    const anchor = container.querySelector('[data-slot="strip-anchor"]');
    expect(anchor).toHaveAttribute("data-placement", "flow");
    expect(anchor?.className ?? "").not.toMatch(/\b(?:h-0|absolute|z-30)\b/);
    const band = anchor?.querySelector('[data-slot="collapse"]');
    expect(band?.className).not.toMatch(/\b(?:absolute|shadow-md)\b/);
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
