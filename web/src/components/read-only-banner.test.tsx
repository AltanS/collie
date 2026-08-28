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

  it("appears for the HEADER gate, and names the device the proxy asserted", () => {
    // Nothing on the phone can fix this one, so the copy explains rather than offering a remedy.
    render(<ReadOnlyBanner device={REFUSED} />);
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.getByText(/pixel-9/)).toBeInTheDocument();
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
    // The primitive's floor, which this feature may not lower — two one-line notices anywhere in
    // the app are the same height because of it.
    expect(box(container)).toHaveClass("min-h-[42px]");
  });

  it("owns no styling: the className it is handed is the caller's GUTTER, on the collapsing ROW", () => {
    // The seam the pilot exists to prove. The routes pass `mx-4 mt-3` and the pane passes
    // `mx-3 mt-1.5`; the caller supplies the gutter because only the caller knows what the box sits
    // between (DESIGN.md §1). It lands on the row and NOT on the box, which is measured rather than
    // preferred: ui/notice.tsx gives a box `w-full`, so a margin there resolves 100% against the
    // full row and then offsets it — at 390px that put the box 12px past the right edge, clipped,
    // with the right gutter gone. Insetting the row leaves the box filling what remains.
    const { container } = render(<ReadOnlyBanner device={REFUSED} className="mx-4 mt-3" />);
    expect(container.firstElementChild).toHaveClass("mx-4", "mt-3");
    expect(box(container)?.className).not.toMatch(/\bm[xt]-/);
    // And nothing else: this file adds no class of its own on top of the primitive's.
    expect(box(container)?.className).toBe(
      render(<ReadOnlyBanner device={REFUSED} />).container.querySelector(
        '[data-slot="collapse"] > div > div',
      )?.className,
    );
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

    // `clearNotPaired`, not `__resetPairing`: only the real mutator notifies subscribers, and
    // this test is about what the operator sees when the bridge accepts a write again.
    act(() => clearNotPaired());
    expect(container.firstElementChild).toHaveAttribute("data-state", "closed");

    act(() => void vi.advanceTimersByTime(COLLAPSE_MS - 1));
    // One millisecond before the end: still mounted, still carrying the sentence that explains it.
    expect(screen.getByText(/Not paired/)).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(2));
    expect(container).toBeEmptyDOMElement();
  });
});
