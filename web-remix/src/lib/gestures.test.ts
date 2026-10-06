/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
  HOLD_FEEDBACK_DELAY_MS,
  LONG_PRESS_EVENT,
  LONG_PRESS_MS,
  LONG_PRESS_RELEASE_EVENT,
  attachLongPress,
  type GestureNode,
  type Timers,
} from "./gestures";

/** Timers on a hand-cranked clock. */
class FakeTimers implements Timers {
  now = 0;
  #next = 1;
  #queue = new Map<number, { at: number; fn: () => void }>();
  setTimeout(fn: () => void, ms: number): number {
    const id = this.#next++;
    this.#queue.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(id: number): void {
    this.#queue.delete(id);
  }
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let first: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.#queue) if (entry[1].at <= end && (first === null || entry[1].at < first[1].at)) first = entry;
      if (first === null) break;
      this.#queue.delete(first[0]);
      this.now = first[1].at;
      first[1].fn();
    }
    this.now = end;
  }
}

class FakeNode extends EventTarget implements GestureNode {
  attrs = new Map<string, string>();
  style = { animationDuration: "", touchAction: "auto", setProperty: (): void => {} };
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
}

function pointer(type: string, x = 0, y = 0, button = 0): Event {
  return Object.assign(new Event(type, { cancelable: true }), { clientX: x, clientY: y, button, isPrimary: true, pointerId: 1 });
}

function setup(delayMs?: number) {
  const node = new FakeNode();
  const timers = new FakeTimers();
  const ctl = new AbortController();
  const seen: string[] = [];
  node.addEventListener(LONG_PRESS_EVENT, () => seen.push(`press@${String(timers.now)}`));
  node.addEventListener(LONG_PRESS_RELEASE_EVENT, () => seen.push("release"));
  attachLongPress(node, () => (delayMs === undefined ? {} : { delayMs }), ctl.signal, timers);
  return { node, timers, ctl, seen };
}

describe("longPress", () => {
  test("data-holding at 150 ms with the remaining fill, app:longpress at 450 ms", () => {
    const { node, timers, seen } = setup();
    node.dispatchEvent(pointer("pointerdown"));
    timers.advance(HOLD_FEEDBACK_DELAY_MS - 1);
    expect(node.attrs.has("data-holding")).toBe(false);
    timers.advance(1);
    expect(node.attrs.has("data-holding")).toBe(true);
    expect(node.style.animationDuration).toBe(`${String(LONG_PRESS_MS - HOLD_FEEDBACK_DELAY_MS)}ms`);
    timers.advance(LONG_PRESS_MS - HOLD_FEEDBACK_DELAY_MS - 1);
    expect(seen).toEqual([]);
    timers.advance(1);
    expect(seen).toEqual([`press@${String(LONG_PRESS_MS)}`]);
    // The look ends the moment the hold counts.
    expect(node.attrs.has("data-holding")).toBe(false);
    expect(node.style.animationDuration).toBe("");
    node.dispatchEvent(pointer("pointerup"));
    expect(seen).toEqual([`press@${String(LONG_PRESS_MS)}`, "release"]);
  });

  test("a short tap fires nothing and clears the look", () => {
    const { node, timers, seen } = setup();
    node.dispatchEvent(pointer("pointerdown"));
    timers.advance(200);
    expect(node.attrs.has("data-holding")).toBe(true);
    node.dispatchEvent(pointer("pointerup"));
    expect(node.attrs.has("data-holding")).toBe(false);
    timers.advance(1000);
    expect(seen).toEqual([]);
  });

  test("moving past 16 px cancels; inside it does not", () => {
    const { node, timers, seen } = setup();
    node.dispatchEvent(pointer("pointerdown", 100, 100));
    node.dispatchEvent(pointer("pointermove", 110, 110));
    timers.advance(LONG_PRESS_MS);
    expect(seen.length).toBe(1);
    node.dispatchEvent(pointer("pointerup"));
    seen.length = 0;
    node.dispatchEvent(pointer("pointerdown", 100, 100));
    node.dispatchEvent(pointer("pointermove", 117, 100));
    timers.advance(LONG_PRESS_MS);
    expect(seen).toEqual([]);
  });

  test("the click after a hold is swallowed in capture; a plain click passes", () => {
    const { node, timers } = setup();
    let clicks = 0;
    node.addEventListener("click", () => clicks++);
    node.dispatchEvent(pointer("pointerdown"));
    timers.advance(LONG_PRESS_MS);
    node.dispatchEvent(new Event("click", { cancelable: true }));
    expect(clicks).toBe(0);
    node.dispatchEvent(pointer("pointerdown"));
    node.dispatchEvent(pointer("pointerup"));
    node.dispatchEvent(new Event("click", { cancelable: true }));
    expect(clicks).toBe(1);
  });

  test("a delay under the feedback delay shows no fill; abort detaches", () => {
    const { node, timers, ctl, seen } = setup(100);
    node.dispatchEvent(pointer("pointerdown"));
    timers.advance(100);
    expect(seen).toEqual(["press@100"]);
    expect(node.attrs.has("data-holding")).toBe(false);
    node.dispatchEvent(pointer("pointerup"));
    ctl.abort();
    seen.length = 0;
    node.dispatchEvent(pointer("pointerdown"));
    timers.advance(1000);
    expect(seen).toEqual([]);
  });

  test("a right button does not start a hold", () => {
    const { node, timers, seen } = setup();
    node.dispatchEvent(pointer("pointerdown", 0, 0, 2));
    timers.advance(1000);
    expect(seen).toEqual([]);
  });
});
