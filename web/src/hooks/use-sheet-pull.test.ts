import { render } from "@testing-library/react";
import { createElement } from "react";

import { FLING_PX_PER_MS, maxPullForAnchor, OPEN_PX, SLOP, shouldOpen, useSheetPull } from "./use-sheet-pull";

// The pure decision table, plus the one piece of the touch half that cannot be read off the rest of
// the app: which AXIS a gesture belongs to. The hook sits on the actions belt now, a horizontal
// scroller, so every touch it sees may belong to the scroller instead - and the arbitration that
// decides is the thing a change here would break silently.
describe("shouldOpen", () => {
  it("stays closed on a short, slow pull", () => {
    expect(shouldOpen(40, 0.1)).toBe(false);
  });

  it("opens once the pull reaches OPEN_PX, regardless of speed", () => {
    expect(shouldOpen(OPEN_PX, 0)).toBe(true);
  });

  it("opens on a short pull that is a fast fling", () => {
    expect(shouldOpen(SLOP + 1, FLING_PX_PER_MS)).toBe(true);
  });

  it("never opens on a downward (zero-pull) release", () => {
    expect(shouldOpen(0, 5)).toBe(false);
  });

  it("a fling under SLOP still doesn't open  -  that's noise, not a drag", () => {
    expect(shouldOpen(SLOP, 10)).toBe(false);
  });
});

// The anchor clamp: how far a peek's TOP edge (anchor + pull) may still travel before it would
// overshoot the sheet's own max-height. Given an explicit sheetMax so the test doesn't depend on
// jsdom's innerHeight.
describe("maxPullForAnchor", () => {
  it("gives back the full ceiling when the handle sits at the viewport bottom", () => {
    expect(maxPullForAnchor(0, 600)).toBe(600);
  });

  it("subtracts what the anchor already spent", () => {
    expect(maxPullForAnchor(100, 600)).toBe(500);
  });

  it("never goes negative — an anchor past the ceiling clamps to 0, not a negative pull", () => {
    expect(maxPullForAnchor(900, 600)).toBe(0);
  });
});

// ── The axis arbitration ─────────────────────────────────────────────────────
//
// jsdom has no touch input of its own, so each gesture is dispatched by hand: a bare `Event` with a
// `touches` list defined on it, which is every field this hook reads. `touchmove` is cancelable so a
// case can read back whether the hook took the gesture (`preventDefault`) or handed it to the
// browser, which is the difference between the switcher opening and the belt scrolling.

interface Point {
  x: number;
  y: number;
}

/** One synthetic touch event at one point, dispatched on `node`; returns it so a case can read
 *  `defaultPrevented` back off it. */
function touch(node: HTMLElement, type: string, { x, y }: Point): Event {
  const event = new Event(type, { bubbles: true, cancelable: type === "touchmove" });
  Object.defineProperty(event, "touches", { value: [{ clientX: x, clientY: y }] });
  node.dispatchEvent(event);
  return event;
}

/** Mounts the hook on a bare div and hands back the node plus the callbacks, so a case asserts on
 *  what the hook REPORTED rather than on any DOM it drew. */
function mountPull() {
  const onPull = vi.fn();
  const onAnchor = vi.fn();
  const onOpen = vi.fn();
  const onCancel = vi.fn();
  let node: HTMLElement | null = null;
  function Probe() {
    // An explicit `max`, because the default clamp reads `window.innerHeight` and a jsdom div sits
    // at the top of a 768px window — an anchor past the sheet's own ceiling, which clamps every
    // pull to 0 and would make these cases read the arbitration off a number that is always zero.
    const { ref } = useSheetPull({ onPull, onAnchor, onOpen, onCancel, max: 1_000 });
    return createElement("div", {
      ref: (el: HTMLElement | null) => {
        node = el;
        ref(el);
      },
    });
  }
  render(createElement(Probe));
  if (!node) throw new Error("the probe never attached");
  // SAFETY: the throw above is the null check — `render` is synchronous, so the ref callback has
  // already run by here, and the element it was handed is the probe's own <div>, never an SVG or
  // other non-HTMLElement. The assertion is only needed because TypeScript cannot narrow a `let`
  // written inside a closure.
  return { node: node as HTMLElement, onPull, onAnchor, onOpen, onCancel };
}

describe("useSheetPull — which gesture is the hook's", () => {
  it("engages on a mostly-vertical move and takes the gesture", () => {
    const { node, onPull, onAnchor, onOpen, onCancel } = mountPull();
    touch(node, "touchstart", { x: 100, y: 400 });
    // The anchor is measured once, on touchstart, whatever the gesture turns out to be.
    expect(onAnchor).toHaveBeenCalledTimes(1);
    const move = touch(node, "touchmove", { x: 104, y: 400 - (SLOP + 30) });
    expect(onPull).toHaveBeenCalledWith(SLOP + 30);
    expect(move.defaultPrevented).toBe(true);
    touch(node, "touchend", { x: 104, y: 400 - (SLOP + 30) });
    // An ENGAGED release always decides, one way or the other. Which way is shouldOpen's table
    // above, and it is not this case's question: what is asserted here is that the gesture was the
    // hook's at all, which a scroller's gesture never is (the next two cases).
    expect(onOpen.mock.calls.length + onCancel.mock.calls.length).toBe(1);
  });

  it("never engages on a mostly-horizontal move, and leaves that gesture to the scroller", () => {
    const { node, onPull, onOpen, onCancel } = mountPull();
    touch(node, "touchstart", { x: 100, y: 400 });
    const move = touch(node, "touchmove", { x: 100 + SLOP + 40, y: 400 - 4 });
    expect(onPull).not.toHaveBeenCalled();
    // NOT prevented is the whole point: the browser's own pan-x keeps the belt scrolling.
    expect(move.defaultPrevented).toBe(false);
    touch(node, "touchend", { x: 100 + SLOP + 40, y: 400 - 4 });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps an abandoned gesture abandoned, however far up the finger later travels", () => {
    const { node, onPull, onOpen, onCancel } = mountPull();
    touch(node, "touchstart", { x: 100, y: 400 });
    // A pan first — this touch is the scroller's from here on.
    touch(node, "touchmove", { x: 160, y: 398 });
    // …and then a long pull upward, which would open the sheet twice over if the latch let go.
    const late = touch(node, "touchmove", { x: 160, y: 400 - (OPEN_PX + 60) });
    expect(onPull).not.toHaveBeenCalled();
    expect(late.defaultPrevented).toBe(false);
    touch(node, "touchend", { x: 160, y: 400 - (OPEN_PX + 60) });
    expect(onOpen).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("starts each touch fresh — the next gesture is judged on its own axis", () => {
    const { node, onPull } = mountPull();
    touch(node, "touchstart", { x: 100, y: 400 });
    touch(node, "touchmove", { x: 160, y: 398 });
    touch(node, "touchend", { x: 160, y: 398 });
    expect(onPull).not.toHaveBeenCalled();
    touch(node, "touchstart", { x: 160, y: 400 });
    touch(node, "touchmove", { x: 160, y: 400 - (SLOP + 20) });
    expect(onPull).toHaveBeenCalledWith(SLOP + 20);
  });
});
