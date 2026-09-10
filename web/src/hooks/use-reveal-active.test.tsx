import { useLayoutEffect, useRef } from "react";
import { render } from "@testing-library/react";

import { useRevealActive } from "./use-reveal-active";

// jsdom lays nothing out — every box is 0x0 — so the harness stubs `clientWidth` and
// `getBoundingClientRect` on the scroller and the active element by hand, via a `useLayoutEffect`
// declared BEFORE the call to `useRevealActive`. Hooks in one component fire in declaration order,
// so this always sets the geometry the reveal hook reads before it reads it, on every render — mount
// included.
interface Rect {
  left: number;
  right: number;
}

function Harness({
  activeKey,
  scrollerRect,
  activeRect,
  clientWidth,
  scrollLeft = 0,
  scrollToSpy,
}: {
  activeKey: string;
  scrollerRect: Rect;
  activeRect: Rect;
  clientWidth: number;
  scrollLeft?: number;
  scrollToSpy: (opts: { left: number; behavior?: ScrollBehavior }) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    Object.defineProperty(scroller, "clientWidth", { value: clientWidth, configurable: true });
    scroller.scrollLeft = scrollLeft;
    scroller.getBoundingClientRect = (): DOMRect => ({
      ...scrollerRect,
      top: 0,
      bottom: 0,
      width: scrollerRect.right - scrollerRect.left,
      height: 0,
      x: scrollerRect.left,
      y: 0,
      toJSON: () => ({}),
    });
    // SAFETY: the hook only ever calls `scrollTo({ left, behavior })`, the single-argument form —
    // the test spy matches that shape exactly, so the mismatch with `Element.scrollTo`'s wider
    // overload set (which also accepts two numeric coordinates) is never exercised.
    scroller.scrollTo = scrollToSpy as Element["scrollTo"];
    const active = scroller.querySelector<HTMLElement>('[aria-current="true"]');
    if (active) {
      active.getBoundingClientRect = (): DOMRect => ({
        ...activeRect,
        top: 0,
        bottom: 0,
        width: activeRect.right - activeRect.left,
        height: 0,
        x: activeRect.left,
        y: 0,
        toJSON: () => ({}),
      });
    }
  });

  useRevealActive(scrollerRef, activeKey);

  return (
    <div ref={scrollerRef}>
      <button aria-current={activeKey === "a" ? "true" : undefined}>a</button>
      <button aria-current={activeKey === "b" ? "true" : undefined}>b</button>
    </div>
  );
}

const HIDDEN_RIGHT = { left: 500, right: 600 };
const VISIBLE = { left: 50, right: 150 };
const SCROLLER = { left: 0, right: 346 };

describe("useRevealActive", () => {
  afterEach(() => {
    // Some cases override `matchMedia` for reduced motion; leave a clean environment behind.
    // @ts-expect-error -- test-only cleanup of a test-only override.
    delete window.matchMedia;
  });

  it("scrolls an off-screen active element to its nearest edge", () => {
    const scrollTo = vi.fn();
    render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={HIDDEN_RIGHT}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // Off the RIGHT edge: target = scrollLeft(0) + (activeRect.right - scrollerRect.right) + margin.
    const [call] = scrollTo.mock.calls;
    expect(call[0].left).toBeCloseTo(0 + (HIDDEN_RIGHT.right - SCROLLER.right) + 12);
  });

  it("does not scroll an already-visible active element", () => {
    const scrollTo = vi.fn();
    render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={VISIBLE}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("uses instant (auto) behavior on the very first reveal after mount", () => {
    const scrollTo = vi.fn();
    render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={HIDDEN_RIGHT}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("uses smooth behavior on a later selection change", () => {
    const scrollTo = vi.fn();
    const { rerender } = render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={VISIBLE}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled(); // "a" starts visible — the mount reveal is a no-op call.

    rerender(
      <Harness
        activeKey="b"
        scrollerRect={SCROLLER}
        activeRect={HIDDEN_RIGHT}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  });

  it("forces auto even on a later change when reduced motion is on", () => {
    // SAFETY: the hook only reads `.matches` off the object `window.matchMedia(query)` returns —
    // the rest of `MediaQueryList` (`media`, `addEventListener`, …) is never touched by it.
    const reducedMotion = { matches: true } as MediaQueryList;
    window.matchMedia = vi.fn().mockReturnValue(reducedMotion);
    const scrollTo = vi.fn();
    const { rerender } = render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={VISIBLE}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    rerender(
      <Harness
        activeKey="b"
        scrollerRect={SCROLLER}
        activeRect={HIDDEN_RIGHT}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
  });

  it("does nothing when the scroller has no layout (clientWidth 0, unstubbed jsdom)", () => {
    function Bare() {
      const ref = useRef<HTMLDivElement>(null);
      useRevealActive(ref, "a");
      return (
        <div ref={ref}>
          <button aria-current="true">a</button>
        </div>
      );
    }
    expect(() => render(<Bare />)).not.toThrow();
  });

  it("does nothing when there is no element carrying aria-current", () => {
    const scrollTo = vi.fn();
    function NoActive() {
      const ref = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        Object.defineProperty(el, "clientWidth", { value: 346, configurable: true });
        // SAFETY: same single-argument `scrollTo({ left, behavior })` shape as the Harness above.
        el.scrollTo = scrollTo as Element["scrollTo"];
      });
      useRevealActive(ref, null);
      return (
        <div ref={ref}>
          <button>a</button>
        </div>
      );
    }
    render(<NoActive />);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
