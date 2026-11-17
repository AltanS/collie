import { useLayoutEffect, useRef } from "react";
import { fireEvent, render } from "@testing-library/react";

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
  scrollLeft,
  memoryKey,
  scrollToSpy,
}: {
  activeKey: string;
  scrollerRect: Rect;
  activeRect: Rect;
  clientWidth: number;
  scrollLeft?: number;
  memoryKey?: string;
  scrollToSpy: (opts: { left: number; behavior?: ScrollBehavior }) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    Object.defineProperty(scroller, "clientWidth", { value: clientWidth, configurable: true });
    if (scrollLeft !== undefined) scroller.scrollLeft = scrollLeft;
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

  useRevealActive(scrollerRef, activeKey, memoryKey);

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

  it("scrolls an active element that is off the LEFT edge to that edge", () => {
    const scrollTo = vi.fn();
    render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={{ left: -90, right: 10 }}
        clientWidth={346}
        scrollLeft={300}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).toHaveBeenCalledTimes(1);
    // nearest: scrollLeft(300) + (activeRect.left - scrollerRect.left) - margin
    expect(scrollTo.mock.calls[0]![0].left).toBeCloseTo(300 + -90 - 12);
  });

  it("never moves an item that is fully visible, even one flush with the edge", () => {
    const scrollTo = vi.fn();
    render(
      <Harness
        activeKey="a"
        scrollerRect={SCROLLER}
        activeRect={{ left: 250, right: SCROLLER.right }}
        clientWidth={346}
        scrollToSpy={scrollTo}
      />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("a tap on an item does not scroll the strip, even when the item is partly out of view", () => {
    const scrollTo = vi.fn();
    const props = { scrollerRect: SCROLLER, clientWidth: 346, scrollToSpy: scrollTo };
    const { container, rerender } = render(<Harness activeKey="a" activeRect={VISIBLE} {...props} />);
    expect(scrollTo).not.toHaveBeenCalled();

    // The operator taps "b", which sits half under the right edge; the selection then moves to it.
    fireEvent.click(container.querySelectorAll("button")[1]!);
    rerender(<Harness activeKey="b" activeRect={{ left: 300, right: 400 }} {...props} />);
    expect(scrollTo).not.toHaveBeenCalled();

    // The tap's claim is spent: a later change made elsewhere is scrolled in again.
    rerender(<Harness activeKey="a" activeRect={HIDDEN_RIGHT} {...props} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("a remounted strip gets its scroll position back and a tap leaves it there", () => {
    const scrollTo = vi.fn();
    const props = { scrollerRect: SCROLLER, clientWidth: 346, scrollToSpy: scrollTo, memoryKey: "test-strip" };
    const first = render(<Harness activeKey="a" activeRect={VISIBLE} scrollLeft={240} {...props} />);
    // SAFETY: the Harness renders one <div> scroller as its root, so the first child is that element.
    const before = first.container.firstElementChild as HTMLElement;
    before.scrollLeft = 240;
    fireEvent.scroll(before);
    fireEvent.click(first.container.querySelectorAll("button")[1]!);
    first.unmount();

    // The new scroller starts at 0 (a fresh DOM node) and the tapped item is partly out of view.
    const second = render(<Harness activeKey="b" activeRect={{ left: 300, right: 400 }} {...props} />);
    // SAFETY: same root <div> scroller as above.
    const after = second.container.firstElementChild as HTMLElement;
    expect(after.scrollLeft).toBe(240);
    expect(scrollTo).not.toHaveBeenCalled();
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
