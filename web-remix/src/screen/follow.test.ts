import { describe, expect, test } from "bun:test";

import { createTailPin, isAtBottom, type ScrollBox } from "./follow";

/** A scroller the size of a phone pane: the browser clamps scrollTop to scrollHeight - clientHeight. */
function box(scrollHeight: number, clientHeight = 500): ScrollBox {
  let top = 0;
  return {
    clientHeight,
    scrollHeight,
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight));
    },
  };
}

describe("createTailPin", () => {
  test("a scroll that lands where the pin put it is the scroller's own, even after content grew", () => {
    const b = box(2000);
    const tail = createTailPin();
    tail.pin(b);
    expect(isAtBottom(b)).toBe(true);
    b.scrollHeight = 2030; // a row arrived before the pin's scroll event was read
    expect(isAtBottom(b)).toBe(false);
    expect(tail.ours(b)).toBe(true);
  });

  test("a reader's scroll moves off the pinned spot and is not ours", () => {
    const b = box(2000);
    const tail = createTailPin();
    tail.pin(b);
    b.scrollTop = b.scrollTop - 120;
    expect(tail.ours(b)).toBe(false);
  });

  test("before any pin nothing is ours", () => {
    expect(createTailPin().ours(box(2000))).toBe(false);
  });
});
