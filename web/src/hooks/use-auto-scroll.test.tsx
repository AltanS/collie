import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";

import { useAutoScroll } from "./use-auto-scroll";

// use-auto-scroll's stickiness needs a real DOM ref (scrollRef attached to an element) plus a
// ResizeObserver — jsdom has neither the layout nor the observer, so we mount a tiny harness, pin
// the element's scroll metrics by hand, and drive a mocked ResizeObserver's callback ourselves.

type Observed = { el: Element; cb: ResizeObserverCallback };

// Every constructed observer, so tests can fire container and/or content observations.
let observers: Observed[] = [];
class MockResizeObserver {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    observers.push({ el, cb: this.cb });
  }
  unobserve() {}
  disconnect() {
    observers = observers.filter((o) => o.cb !== this.cb);
  }
}

function setMetrics(
  el: HTMLElement,
  m: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(el, "scrollHeight", { value: m.scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: m.clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: m.scrollTop, configurable: true, writable: true });
}

function Harness({ dep = "constant" }: { dep?: unknown }) {
  const { scrollRef, onScroll } = useAutoScroll<HTMLDivElement>({ dep });
  return (
    <div ref={scrollRef} onScroll={onScroll} data-testid="scroll">
      <div data-testid="content">body</div>
    </div>
  );
}

function GrowingHarness() {
  const [dep, setDep] = useState("a");
  const { scrollRef, onScroll, scrollToBottom } = useAutoScroll<HTMLDivElement>({ dep });
  return (
    <div>
      <div ref={scrollRef} onScroll={onScroll} data-testid="scroll">
        <div data-testid="content">body</div>
      </div>
      <button type="button" onClick={() => setDep("b")} data-testid="grow-dep">
        grow dep
      </button>
      <button type="button" onClick={() => scrollToBottom()} data-testid="jump">
        jump
      </button>
    </div>
  );
}

function fireResize(el: Element) {
  for (const o of observers.filter((x) => x.el === el)) {
    o.cb([], {} as ResizeObserver);
  }
}

describe("useAutoScroll — resize re-pin", () => {
  // jsdom has no Element.scrollTo; the mount-time follow effect calls it, so keep a harmless default
  // on the prototype and shadow it per-test with a spy on the specific element.
  beforeAll(() => {
    if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  });
  beforeEach(() => {
    observers = [];
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
    act(() => fireResize(el));

    expect(scrollTo).toHaveBeenCalledWith({ top: 500, behavior: "auto" });
  });

  it("re-pins when CONTENT grows while following (pane open / AnsiOutput layout)", () => {
    // Opening a pane paints the scroll container at its final flex height first; the terminal
    // mirror's content then grows inside it. That does NOT resize the container — only the child —
    // so stickiness must observe content too, or the view stays stuck at the top of scrollback.
    const { getByTestId } = render(<Harness />);
    const el = getByTestId("scroll");
    const content = getByTestId("content");
    setMetrics(el, { scrollHeight: 500, clientHeight: 200, scrollTop: 0 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    act(() => fireResize(content));

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
    act(() => fireResize(el));

    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("pins to the bottom on mount / when dep changes while following", () => {
    const { getByTestId } = render(<GrowingHarness />);
    const el = getByTestId("scroll");
    setMetrics(el, { scrollHeight: 800, clientHeight: 200, scrollTop: 0 });
    const scrollTo = vi.fn();
    el.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];

    act(() => fireEvent.click(getByTestId("grow-dep")));

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "auto" });
  });

  it("no-ops without a ResizeObserver (jsdom / older browsers)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    // Mounting must not throw when the observer is absent — the effect bails on the typeof guard.
    expect(() => render(<Harness />)).not.toThrow();
  });
});
