import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useStripSnap } from "./use-strip-snap";

// jsdom lays nothing out, so the strip is a plain div whose scroll metrics are pinned by hand and
// whose scrollTo is a spy that moves scrollLeft the way an instant scroll would.

const STARTS = [0, 400, 800, 1200];

let scrollTo: ReturnType<typeof vi.fn>;
let position = 0;

function pin(el: HTMLElement) {
  position = 0;
  Object.defineProperty(el, "scrollLeft", { get: () => position, set: (v: number) => (position = v), configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: 1600, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: 800, configurable: true });
  scrollTo = vi.fn((opts: ScrollToOptions) => {
    // An instant scroll lands at once; a smooth one is moved by the test with `glide`.
    if (opts.behavior !== "smooth" && opts.left !== undefined) position = opts.left;
  });
  Object.defineProperty(el, "scrollTo", { value: scrollTo, configurable: true });
}

function Harness({ onSettled, reducedMotion = false }: { onSettled?: (x: number) => void; reducedMotion?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useStripSnap(ref, { columnStarts: () => STARTS, onSettled, reducedMotion });
  return <div ref={ref} data-slot="strip" />;
}

function mount(props: { onSettled?: (x: number) => void; reducedMotion?: boolean } = {}) {
  const view = render(<Harness {...props} />);
  const strip = view.container.querySelector<HTMLElement>('[data-slot="strip"]');
  if (strip === null) throw new Error("strip not rendered");
  pin(strip);
  return { ...view, strip };
}

function wheel(strip: HTMLElement, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  act(() => {
    strip.dispatchEvent(event);
  });
  return event;
}

function scrollEvent(strip: HTMLElement) {
  act(() => {
    strip.dispatchEvent(new Event("scroll"));
  });
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useStripSnap", () => {
  it("waits for the wheel to go quiet, then eases to the nearest start", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    wheel(strip, { deltaX: 40 });
    advance(100);
    expect(scrollTo).not.toHaveBeenCalled();
    position = 560;
    scrollEvent(strip);
    advance(100);
    expect(scrollTo).not.toHaveBeenCalled();
    advance(30);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ left: 400, behavior: "smooth" });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("calls onSettled once, after the ease has stopped", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    wheel(strip, { deltaX: 40 });
    advance(120);
    // The smooth scroll keeps firing scroll events while it glides.
    for (const x of [510, 470, 430, 400]) {
      position = x;
      scrollEvent(strip);
      advance(16);
    }
    expect(onSettled).not.toHaveBeenCalled();
    advance(120);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(400);
    advance(500);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("treats trackpad inertia as part of the gesture", () => {
    const { strip } = mount();
    position = 100;
    for (let i = 0; i < 10; i++) {
      wheel(strip, { deltaX: 8 });
      position += 8;
      advance(60);
    }
    expect(scrollTo).not.toHaveBeenCalled();
    advance(60);
    expect(scrollTo).toHaveBeenCalledWith({ left: 0, behavior: "smooth" });
  });

  it("uses an instant scroll under reduced motion", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled, reducedMotion: true });
    position = 530;
    wheel(strip, { deltaX: 10 });
    advance(120);
    expect(scrollTo).toHaveBeenCalledWith({ left: 400, behavior: "auto" });
    advance(120);
    expect(onSettled).toHaveBeenCalledWith(400);
  });

  it("does not scroll when the strip already sits on a start, but still reports it", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 800.5;
    wheel(strip, { deltaX: 10 });
    advance(120);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(800.5);
  });

  it("starts the gesture afresh when the wheel turns during the ease", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    wheel(strip, { deltaX: 40 });
    advance(120);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    position = 450;
    wheel(strip, { deltaX: 40 });
    position = 700;
    advance(120);
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: "smooth" });
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("ignores a plain vertical wheel", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    const event = wheel(strip, { deltaY: 100 });
    advance(500);
    expect(event.defaultPrevented).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("turns Shift plus a vertical wheel into sideways scrolling", () => {
    const { strip } = mount();
    position = 0;
    const first = wheel(strip, { deltaY: 100, shiftKey: true });
    expect(first.defaultPrevented).toBe(true);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 100, behavior: "auto" });
    wheel(strip, { deltaY: 100, shiftKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 200, behavior: "auto" });
    wheel(strip, { deltaY: 100, shiftKey: true });
    // A browser snap pulled the position back to the first start meanwhile: the sum still counts.
    position = 0;
    advance(120);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: "smooth" });
  });

  it("keeps Shift plus the wheel inside the strip's bounds", () => {
    const { strip } = mount();
    position = 790;
    wheel(strip, { deltaY: 500, shiftKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 800, behavior: "auto" });
    wheel(strip, { deltaY: -5000, shiftKey: true });
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 0, behavior: "auto" });
  });

  it("leaves a sideways wheel to the browser", () => {
    const { strip } = mount();
    const event = wheel(strip, { deltaX: 60 });
    expect(event.defaultPrevented).toBe(false);
  });

  it("does nothing for touch", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    act(() => {
      strip.dispatchEvent(new Event("touchstart", { bubbles: true }));
    });
    wheel(strip, { deltaX: 40 });
    scrollEvent(strip);
    advance(500);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    act(() => {
      strip.dispatchEvent(new Event("touchend", { bubbles: true }));
    });
    wheel(strip, { deltaX: 40 });
    advance(120);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("ignores scroll events no wheel started", () => {
    const onSettled = vi.fn();
    const { strip } = mount({ onSettled });
    position = 530;
    scrollEvent(strip);
    advance(500);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("drops a pending gesture and its listeners on unmount", () => {
    const onSettled = vi.fn();
    const { strip, unmount } = mount({ onSettled });
    const remove = vi.spyOn(strip, "removeEventListener");
    position = 530;
    wheel(strip, { deltaX: 40 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(["wheel", "scroll", "touchstart", "touchend", "touchcancel", "pointerdown", "pointerup", "pointercancel"]),
    );
    wheel(strip, { deltaX: 40 });
    advance(500);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
