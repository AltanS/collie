import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restingScroll, springAt, stripGeometry } from "@/lib/wide-layout";

import { useViewGlide, type GlideInput, type ViewGlide } from "./use-view-glide";

// WHO OWNS THE SCROLL DURING A GLIDE. jsdom lays nothing out, so the strip is a div whose width and
// scroll are pinned by hand, the animation frames run when the test says, and the clock is the test's.
// The engine half (that the strip rests where reduced motion rests) is e2e/wide-glide.spec.ts.

const W = 1120;
let position = 0;
let now = 0;
let frames: FrameRequestCallback[] = [];

function pin(el: HTMLElement) {
  position = 0;
  Object.defineProperty(el, "scrollLeft", { get: () => position, set: (v: number) => (position = v), configurable: true });
  Object.defineProperty(el, "clientWidth", { value: W, configurable: true });
}

/** Run frames every 16 ms from the last one until the motion rests; returns the scroll per frame. */
function settle(): number[] {
  const out: number[] = [];
  for (let i = 0; i < 200 && frames.length > 0; i += 1) {
    frameAt(now + 16);
    out.push(position);
  }
  expect(frames).toEqual([]);
  return out;
}

/** Run the frames due at `t` ms after the glide began. */
function frameAt(t: number) {
  now = t;
  const due = frames;
  frames = [];
  act(() => {
    for (const f of due) f(t);
  });
}

function input(fractions: number[], focusAt: number): GlideInput {
  return { signature: fractions.join(","), fractions, addWidth: stripGeometry(fractions, W, true).addWidth, stripWidth: W, wide: true, focusAt };
}

let glide: ViewGlide;
function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  glide = useViewGlide(ref);
  return (
    <div ref={(el) => {
      ref.current = el;
      if (el !== null) pin(el);
    }} data-slot="strip">
      <section data-col-index="0" />
      <section data-col-index="1" />
      <div data-slot="add-column" />
    </div>
  );
}

const options = { reduced: false, book: false, onEnd: () => {} };

/** The person picks a width: claim from the act, then the layout run that React's commit triggers. */
function pick(fractions: number[]) {
  const next = input(fractions, 1);
  glide.claim(next.signature);
  let started = false;
  act(() => {
    started = glide.run(next, options);
  });
  return started;
}

function touch(type: string, x: number) {
  const strip = document.querySelector('[data-slot="strip"]')!;
  strip.dispatchEvent(Object.assign(new Event(type), { touches: type === "touchend" ? [] : [{ clientX: x, clientY: 500 }] }));
}

beforeEach(() => {
  now = 0;
  frames = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  render(<Harness />);
  // The strip as it rests: 1/2 and 1/2, the second focused, at the start.
  act(() => {
    glide.run(input([0.5, 0.5], 1), options);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useViewGlide", () => {
  it("drives the scroll on the eased clock to the resting place", () => {
    expect(pick([0.5, 0.8])).toBe(true);
    frameAt(120);
    expect(position).toBeGreaterThan(0);
    expect(position).toBeLessThan(560);
    settle();
    expect(position).toBe(560);
  });

  it("a finger that taps the strip during a glide leaves the scroll to the glide", () => {
    pick([0.5, 0.8]);
    frameAt(60);
    const mid = position;
    touch("touchstart", 900);
    touch("touchmove", 904);
    touch("touchend", 904);
    frameAt(120);
    expect(position).toBeGreaterThan(mid);
    settle();
    expect(position).toBe(560);
  });

  it("a quick second tap with a finger: the second glide still drives the scroll to its end", () => {
    pick([0.5, 0.8]);
    frameAt(60);
    touch("touchstart", 900);
    touch("touchend", 900);
    now = 80;
    expect(pick([0.5, 1])).toBe(true);
    frameAt(140);
    expect(position).toBeLessThan(560);
    settle();
    expect(position).toBe(560);
  });

  it("a finger that moves past the slop takes the scroll, and the glide stops writing it", () => {
    pick([0.5, 0.8]);
    frameAt(60);
    touch("touchstart", 900);
    touch("touchmove", 880);
    position = 300;
    touch("touchend", 880);
    settle();
    expect(position).toBe(300);
  });

  it("a width act after the person scrolled takes the scroll back, from where they left it", () => {
    pick([0.5, 0.8]);
    frameAt(60);
    touch("touchstart", 900);
    touch("touchmove", 700);
    position = 100;
    touch("touchend", 700);
    frameAt(90);
    // The second act: its end is computed from the live 100, as the jump computes it.
    now = 100;
    expect(pick([0.5, 1])).toBe(true);
    const want = restingScroll(stripGeometry([0.5, 1], W, true), 1, 100, W);
    frameAt(160);
    expect(position).toBeGreaterThan(100);
    settle();
    expect(position).toBe(want);
  });

  it("the end of that act is computed from where the person left the strip, not from the first glide's end", () => {
    pick([0.5, 0.8]);
    frameAt(60);
    touch("touchstart", 900);
    touch("touchmove", 1100);
    position = 0;
    touch("touchend", 1100);
    frameAt(90);
    // Back to 1/2 from the start of the strip: the column is whole there, so the strip stays at 0. From
    // the first glide's end, 560, it would have stayed at 560.
    now = 100;
    pick([0.5, 0.5]);
    expect(restingScroll(stripGeometry([0.5, 0.5], W, true), 1, 0, W)).toBe(0);
    settle();
    expect(position).toBe(0);
  });

  it("a retarget carries the speed: the scroll goes on from where it is, with no step back, to the new rest", () => {
    pick([0.5, 0.8]);
    frameAt(40);
    const at40 = position;
    // Where the first spring alone would stand one frame later, and its speed at 40 ms.
    const alone = springAt(0, 560, 0, 0.056).x;
    const { v } = springAt(0, 560, 0, 0.04);
    now = 40;
    pick([0.5, 1]);
    // The first frame of the second act continues the first: no step back toward the start, and it moves
    // as far as the carried speed takes it (both ends are 560, so the path is the first spring's own).
    expect(position).toBe(at40);
    frameAt(56);
    expect(position).toBeGreaterThan(at40);
    expect(v).toBeGreaterThan(0);
    expect(position).toBeCloseTo(alone, 6);
    const path = settle();
    for (let i = 1; i < path.length; i += 1) expect(path[i]!).toBeGreaterThanOrEqual(path[i - 1]! - 1e-9);
    // The jump's rest for the same two acts.
    expect(position).toBe(restingScroll(stripGeometry([0.5, 1], W, true), 1, restingScroll(stripGeometry([0.5, 0.8], W, true), 1, 0, W), W));
  });

  it("the widths retarget with their speed too: the second column's basis never steps back", () => {
    const col = () => Number.parseFloat(document.querySelector<HTMLElement>('[data-col-index="1"]')!.style.flex.split(" ")[2]!);
    pick([0.5, 0.8]);
    frameAt(40);
    const at40 = col();
    now = 40;
    pick([0.5, 1]);
    expect(col()).toBeCloseTo(at40, 9);
    const seen = [at40];
    for (let i = 0; i < 200 && frames.length > 0; i += 1) {
      frameAt(now + 16);
      seen.push(col());
    }
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]! - 1e-9);
    expect(seen.at(-1)).toBe(100);
  });

  it("a focus follow moves the scroll on the same spring, and a reduced one jumps", () => {
    act(() => glide.follow(560, { reduced: false, onEnd: () => {} }));
    frameAt(40);
    expect(position).toBeCloseTo(springAt(0, 560, 0, 0.04).x, 6);
    settle();
    expect(position).toBe(560);
    const strip = document.querySelector<HTMLElement>('[data-slot="strip"]')!;
    const jumps: ScrollToOptions[] = [];
    Object.defineProperty(strip, "scrollTo", { value: (o: ScrollToOptions) => jumps.push(o), configurable: true });
    act(() => glide.follow(0, { reduced: true, onEnd: () => {} }));
    expect(jumps).toEqual([{ left: 0, behavior: "auto" }]);
    expect(frames).toEqual([]);
  });
});
