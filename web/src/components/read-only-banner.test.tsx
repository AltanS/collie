import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

import { __resetPairing, clearNotPaired, markNotPaired } from "@/lib/pairing";
import type { DeviceAuth } from "@/lib/types";
import { COLLAPSE_MS } from "./ui/collapse";
import { ReadOnlyBanner } from "./read-only-banner";

const REFUSED: DeviceAuth = { enforced: true, device: "pixel-9", authorized: false };
const ALLOWED: DeviceAuth = { enforced: true, device: "pixel-9", authorized: true };

/**
 * The Notice's live region is on the BODY, not the root, and `strip-host.tsx` now keeps two
 * permanently-mounted sr-only regions of its own — so a bare `getByRole("status")` is ambiguous the
 * moment this banner shares a tree with a host. Every query below is scoped to this render's own
 * container for that reason.
 */
const box = (container: HTMLElement) => container.querySelector('[data-slot="collapse"] > div > div');

beforeEach(() => __resetPairing());
afterEach(() => {
  __resetPairing();
  vi.useRealTimers();
});

describe("ReadOnlyBanner — the two write gates, one notice", () => {
  it("says nothing at all when neither gate refuses", () => {
    // The normal single-user deployment. The banner is not a hidden element with zero height — it
    // is absent, so it cannot be read out, tabbed into, or measured.
    const { container } = render(<ReadOnlyBanner device={ALLOWED} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing when the device gate is not enforced at all, or not yet known", () => {
    expect(
      render(<ReadOnlyBanner device={{ enforced: false, device: null, authorized: false }} />)
        .container,
    ).toBeEmptyDOMElement();
    expect(render(<ReadOnlyBanner device={undefined} />).container).toBeEmptyDOMElement();
  });

  it("appears for the HEADER gate — and no longer spells the device name", () => {
    // Nothing on the phone can fix this one, so the copy explains rather than offering a remedy.
    //
    // THE DEVICE NAME IS DELIBERATELY GONE. A strip never wraps, by contract (ui/notice.tsx), so it
    // gets the SHORT copy — the `space.readOnly.*` pair, already written and already translated into
    // all six locales for the space route, where it was used by nothing. The suffix it drops was
    // answering "which device is this?" on the device the operator is holding, and the name is still
    // in Settings for the case where a proxy asserts something surprising. That is the price of the
    // ~30px, named here rather than discovered later.
    render(<ReadOnlyBanner device={REFUSED} />);
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByText(/pixel-9/)).toBeNull();
  });

  it("appears for the PAIRING gate, and that gate outranks the header gate", () => {
    // Both can be true at once. Only the pairing one names a remedy this phone can carry out, so it
    // is checked first — and the two must never be on screen together.
    markNotPaired();
    render(<ReadOnlyBanner device={REFUSED} />);
    expect(screen.getByText(/Not paired/)).toBeInTheDocument();
    expect(screen.queryByText(/Read-only/)).toBeNull();
  });

  it("carries the caution tone, from the ONE tint table, and none of its own", () => {
    // The tone is a deliberate choice, not the inherited class string: a refused write gate is a
    // degraded capability — the composer and the tab strip are dead while it stands. `caution` maps
    // to `--status-working`, the token this banner already used, so the pilot changes the structure
    // without moving the appearance. The recipe is asserted on the rendered box rather than in this
    // file's source, because after the migration this file must contain no tint at all.
    const { container } = render(<ReadOnlyBanner device={REFUSED} />);
    expect(box(container)?.className).toContain("border-status-working/40");
    expect(box(container)?.className).toContain("bg-status-working/15");
    // The STRIP's floor, not the box's 42px: the primitive derives it from the 24px tap target its
    // action button is built to, and this feature may not lower it either.
    expect(box(container)).toHaveClass("min-h-[33px]");
  });

  it("owns no styling AND takes no gutter — a strip is full-bleed by contract", () => {
    // THE GUTTER IS GONE, AND SO IS THE PROP THAT CARRIED IT. This was a box: the routes passed
    // `mx-4 mt-3`, the pane passed `mx-3 mt-1.5`, and the caller supplied it because only the caller
    // knew what the box sat between. A box wrapping to two lines in five of six locales plus that
    // margin was ~62px of a phone — more than the pane-switch handle and the agent statusline
    // combined — spent on a standing condition that never changes for the life of the device.
    //
    // A strip is viewport chrome (DESIGN.md §4): full-bleed, one line, no margin, and therefore
    // nothing for a caller to set. Removing the PROP rather than merely stopping passing it is what
    // makes that permanent — a gutter cannot come back one call site at a time.
    const { container } = render(<ReadOnlyBanner device={REFUSED} />);
    const strip = box(container);
    // No margin anywhere: not on the animated row, not on the strip inside it.
    expect(container.firstElementChild?.className).not.toMatch(/(?:^|\s)m[xty]?-/);
    expect(strip?.className).not.toMatch(/(?:^|\s)m[xty]?-/);
    // …and it is the primitive's strip, not the primitive's box: full width, and a bottom rule
    // rather than a rounded outline.
    expect(strip).toHaveClass("w-full");
    expect(strip?.className).not.toMatch(/(?:^|\s)rounded-/);
  });

  it("announces politely, with a role and no aria-live", () => {
    // role="status" is what the `<output>` element this replaced already meant implicitly. Polite,
    // not assertive: the usual case is a box that is true at FIRST paint, where there is nothing to
    // interrupt. A role carries its own liveness, so a role plus an aria-live would ask for polite
    // and assertive at once — the contradiction ui/notice.tsx makes inexpressible.
    const { container } = render(<ReadOnlyBanner device={REFUSED} />);
    const live = container.querySelector('[role="status"]');
    expect(live).not.toBeNull();
    expect(live).toHaveTextContent(/Read-only/);
    expect(container.querySelector("[aria-live]")).toBeNull();
    expect(container.querySelectorAll("[role]")).toHaveLength(1);
  });

  it("does not animate a gate that was already refusing at first paint", () => {
    // Read-only is usually known at loader time, so the box is part of the first frame. There is no
    // shift to smooth over there, and animating it in would manufacture one.
    const { container } = render(<ReadOnlyBanner device={REFUSED} />);
    expect(container.firstElementChild).toHaveAttribute("data-state", "open");
  });

  it("opens smoothly when the pairing gate latches MID-SESSION", () => {
    // The case that pops today: the latch is set by a real write refusal, long after first paint.
    const { container } = render(<ReadOnlyBanner device={ALLOWED} />);
    expect(container).toBeEmptyDOMElement();
    act(() => markNotPaired());
    expect(container.firstElementChild).toHaveAttribute("data-slot", "collapse");
    expect(screen.getByText(/Not paired/)).toBeInTheDocument();
  });

  it("unmounts AFTER the exit, not before, and keeps its words through it", () => {
    // Two failures in one test, because they are the same mistake. Unmount early and there is
    // nothing left to animate out — the box vanishes and the content below teleports. Keep the box
    // but recompute its copy from a condition that is now false and it slides shut on an empty
    // frame, which is the same pop one step quieter. So the last true gate is latched and rendered
    // for the whole exit.
    vi.useFakeTimers();
    markNotPaired();
    const { container } = render(<ReadOnlyBanner device={ALLOWED} />);
    expect(screen.getByText(/Not paired/)).toBeInTheDocument();

    // `clearNotPaired`, not `__resetPairing`: this test is about what the operator sees when the
    // bridge accepts a write again, so it drives the real path rather than the test helper. (Both
    // notify now — `__resetPairing` used to mutate the store silently, which is fixed in
    // lib/pairing.ts and pinned in pairing.test.ts.)
    act(() => clearNotPaired());
    expect(container.firstElementChild).toHaveAttribute("data-state", "closed");

    act(() => void vi.advanceTimersByTime(COLLAPSE_MS - 1));
    // One millisecond before the end: still mounted, still carrying the sentence that explains it.
    expect(screen.getByText(/Not paired/)).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2));
    expect(container).toBeEmptyDOMElement();
  });
});
