import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STILL_MAX_HOLD_MS, STILL_QUIET_MS, useStillWhileTouched } from "./use-still-list";

// A LIST HELD STILL UNDER A FINGER (hitbox proposal 2). What waits is arrival, removal and order; what does not
// is the data of a pane that is drawn, and a list nobody touches.

interface Row {
  id: string;
  status: string;
}
const row = (id: string, status = "idle"): Row => ({ id, status });

let seen: readonly Row[] = [];
let rootEl: HTMLElement | null = null;

function Probe({ live }: { live: readonly Row[] }) {
  const root = useRef<HTMLDivElement | null>(null);
  seen = useStillWhileTouched(live, (r) => r.id, root);
  return (
    <div>
      <div ref={(el) => { root.current = el; rootEl = el; }} data-testid="list">
        {seen.map((r) => (
          <span key={r.id}>{`${r.id}:${r.status}`}</span>
        ))}
      </div>
      <button type="button" data-testid="outside" aria-label="outside" />
    </div>
  );
}

/** A touch event the way a browser sends it: it names the touches that changed. */
function touch(type: "touchstart" | "touchend" | "touchcancel", el: Element, ...ids: number[]): void {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, "changedTouches", { value: ids.map((identifier) => ({ identifier, target: el })) });
  act(() => {
    el.dispatchEvent(e);
  });
}

const ids = () => seen.map((r) => `${r.id}:${r.status}`);

describe("useStillWhileTouched", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("an untouched list is the live list itself, with no copy and no delay", () => {
    const live = [row("a"), row("b")];
    const { rerender } = render(<Probe live={live} />);
    expect(seen).toBe(live);
    const next = [row("c"), ...live];
    rerender(<Probe live={next} />);
    expect(seen).toBe(next);
  });

  it("a pane that arrives while a finger is down waits, and is drawn when the finger has been up 300ms", () => {
    const first = [row("a"), row("b")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("new"), ...first]} />);
    expect(ids()).toEqual(["a:idle", "b:idle"]);
    touch("touchend", rootEl!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS - 1));
    expect(ids()).toEqual(["a:idle", "b:idle"]);
    act(() => vi.advanceTimersByTime(1));
    expect(ids()).toEqual(["new:idle", "a:idle", "b:idle"]);
  });

  it("a pane that leaves while a finger is down stays, and goes when the quiet time is over", () => {
    const { rerender } = render(<Probe live={[row("a"), row("b"), row("c")]} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("a"), row("c")]} />);
    expect(ids()).toEqual(["a:idle", "b:idle", "c:idle"]);
    touch("touchend", rootEl!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(ids()).toEqual(["a:idle", "c:idle"]);
  });

  it("a status change updates the row in place at once, while the list is held", () => {
    const { rerender } = render(<Probe live={[row("a"), row("b")]} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("a", "blocked"), row("b")]} />);
    expect(ids()).toEqual(["a:blocked", "b:idle"]);
  });

  it("a change of data and an arrival in one poll: the data lands, the arrival waits", () => {
    const { rerender } = render(<Probe live={[row("a"), row("b")]} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("x"), row("a", "blocked"), row("b", "working")]} />);
    expect(ids()).toEqual(["a:blocked", "b:working"]);
  });

  it("the list keeps its held order when the live order changes", () => {
    const { rerender } = render(<Probe live={[row("a"), row("b"), row("c")]} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("c"), row("a"), row("b")]} />);
    expect(ids()).toEqual(["a:idle", "b:idle", "c:idle"]);
  });

  it("a touch that starts outside the list holds nothing", () => {
    const first = [row("a")];
    const { rerender, getByTestId } = render(<Probe live={first} />);
    touch("touchstart", getByTestId("outside"), 1);
    const next = [row("new"), ...first];
    rerender(<Probe live={next} />);
    expect(seen).toBe(next);
  });

  it("a second finger keeps the hold until the last one lifts", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    touch("touchstart", rootEl!, 2);
    touch("touchend", rootEl!, 1);
    rerender(<Probe live={[row("new"), ...first]} />);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS * 3));
    expect(ids()).toEqual(["a:idle"]);
    touch("touchend", rootEl!, 2);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(ids()).toEqual(["new:idle", "a:idle"]);
  });

  it("a cancelled touch (the browser took it) ends the hold like a lift", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    rerender(<Probe live={[row("new"), ...first]} />);
    touch("touchcancel", rootEl!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(ids()).toEqual(["new:idle", "a:idle"]);
  });

  it("a new touch inside the quiet time keeps the list held and restarts the wait", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    touch("touchend", rootEl!, 1);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS - 50));
    touch("touchstart", rootEl!, 2);
    rerender(<Probe live={[row("new"), ...first]} />);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS * 2));
    expect(ids()).toEqual(["a:idle"]);
    touch("touchend", rootEl!, 2);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS));
    expect(ids()).toEqual(["new:idle", "a:idle"]);
  });

  it("a mouse press inside the list holds it, and the release lets it go", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    act(() => {
      rootEl!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    rerender(<Probe live={[row("new"), ...first]} />);
    expect(ids()).toEqual(["a:idle"]);
    act(() => {
      rootEl!.dispatchEvent(new Event("pointerup", { bubbles: true }));
      vi.advanceTimersByTime(STILL_QUIET_MS);
    });
    expect(ids()).toEqual(["new:idle", "a:idle"]);
  });

  it("a touch's own pointer events do not end the hold: a scroll cancels the pointer and keeps the finger down", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    const cancel = new Event("pointercancel", { bubbles: true });
    Object.defineProperty(cancel, "pointerType", { value: "touch" });
    act(() => {
      rootEl!.dispatchEvent(cancel);
    });
    rerender(<Probe live={[row("new"), ...first]} />);
    act(() => vi.advanceTimersByTime(STILL_QUIET_MS * 5));
    expect(ids()).toEqual(["a:idle"]);
  });

  it("a touchend that goes to a removed node never reaches the document: the pointerup of that finger ends the hold", () => {
    const first = [row("a"), row("b")];
    const { rerender } = render(<Probe live={first} />);
    // The touch begins on a row; the poll removes that row; its `touchend` goes to the detached node, so the
    // document sees no end at all.
    const target = rootEl!.querySelector("span")!;
    touch("touchstart", target, 1);
    rerender(<Probe live={[row("b")]} />);
    expect(ids()).toEqual(["a:idle", "b:idle"]);
    const detached = target.cloneNode();
    const end = new Event("touchend", { bubbles: false });
    Object.defineProperty(end, "changedTouches", { value: [{ identifier: 1, target: detached }] });
    detached.dispatchEvent(end);
    // The pointer is told to the document: the finger lifted.
    const up = new Event("pointerup", { bubbles: true });
    Object.defineProperty(up, "pointerType", { value: "touch" });
    act(() => {
      document.body.dispatchEvent(up);
      vi.advanceTimersByTime(STILL_QUIET_MS);
    });
    expect(ids()).toEqual(["b:idle"]);
  });

  it("with no end event of any kind the hold still lets go at the ceiling", () => {
    const first = [row("a"), row("b")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!.querySelector("span")!, 1);
    rerender(<Probe live={[row("b")]} />);
    act(() => vi.advanceTimersByTime(STILL_MAX_HOLD_MS - 1));
    expect(ids()).toEqual(["a:idle", "b:idle"]);
    act(() => vi.advanceTimersByTime(1));
    expect(ids()).toEqual(["b:idle"]);
  });

  it("a finger down after the ceiling holds the list again", () => {
    const first = [row("a")];
    const { rerender } = render(<Probe live={first} />);
    touch("touchstart", rootEl!, 1);
    act(() => vi.advanceTimersByTime(STILL_MAX_HOLD_MS));
    touch("touchstart", rootEl!, 2);
    rerender(<Probe live={[row("new"), ...first]} />);
    expect(ids()).toEqual(["a:idle"]);
  });

  it("takes its listeners off when the list unmounts", () => {
    const remove = vi.spyOn(document, "removeEventListener");
    const { unmount } = render(<Probe live={[row("a")]} />);
    unmount();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["touchstart", "touchend", "touchcancel", "pointerdown", "pointerup", "pointercancel"]),
    );
  });
});
