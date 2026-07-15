import { act, fireEvent, render } from "@testing-library/react";

import { useAutoScroll } from "./use-auto-scroll";

// use-auto-scroll's stickiness needs a real DOM ref (scrollRef attached to an element) plus a
// ResizeObserver — jsdom has neither the layout nor the observer, so we mount a tiny harness, pin
// the element's scroll metrics by hand, and drive a mocked ResizeObserver's callback ourselves.

// The most-recently-constructed observer's callback — fire it to simulate a container resize.
let roCallback: ResizeObserverCallback | null = null;
class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    roCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setMetrics(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: m.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: m.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: m.scrollTop, configurable: true, writable: true });
}

function Harness() {
  const { scrollRef, onScroll } = useAutoScroll<HTMLDivElement>({ dep: "constant" });
  return <div ref={scrollRef} onScroll={onScroll} data-testid="scroll" />;
}

describe("useAutoScroll — resize re-pin", () => {
  // jsdom has no Element.scrollTo; the mount-time follow effect calls it, so keep a harmless default
  // on the prototype and shadow it per-test with a spy on the specific element.
  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });
  beforeEach(() => {
    roCallback = null;
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("re-pins to the bottom when the container resizes while following", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    // Content taller than the viewport; the observer fired on mount is a no-op until we drive it.
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 300 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    // Following by default (autoScroll = true), so a resize snaps the tail back into view — pinned
    // to scrollHeight, NOT a recomputed at-bottom (the shrink already pushed the tail off-screen).
    act(() => roCallback?.([], {} as ResizeObserver));

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("does NOT yank the view down on resize when the user has scrolled up", () => {
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    // Scrolled up: 500 - 0 - 200 = 300px from the bottom, past the 24px threshold → not following.
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    fireEvent.scroll(el); // onScroll captures the scrolled-up intent (autoScroll = false)

    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
    act(() => roCallback?.([], {} as ResizeObserver));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("no-ops without a ResizeObserver (jsdom / older browsers)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    // Mounting must not throw when the observer is absent — the effect bails on the typeof guard.
    expect(() => render(<Harness />)).not.toThrow();
  });
});
