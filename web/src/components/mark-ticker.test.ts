// The ticker of the mark contract (`createMarkTicker` in mark-contract.ts): the one timer that draws
// a slow mark in poses. What it must never do is the cost issue 748 was about, so these cases pin
// when it runs at all: one timer for many marks, none with no mark, none on a hidden page, none for
// a mark under the host's pause attributes, none under reduced motion.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MARK_HOLD, createMarkTicker } from "./mark-contract";

/** A stand-in for a CSS animation: what the ticker reads and writes. */
class FakeAnimation {
  readonly animationName = "cm-t0";
  readonly playbackRate: number;
  currentTime = 0;

  constructor(rate = 1) {
    this.playbackRate = rate;
  }
}

/** A mark root in the document whose subtree holds the given animations. */
function markWith(animations: FakeAnimation[], parent: Element = document.body): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.defineProperty(el, "getAnimations", { value: () => animations });
  parent.append(el);
  return el;
}

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

/** Let the MutationObserver's callback run (a microtask). */
async function observed(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "visibilityState");
  Reflect.deleteProperty(window, "matchMedia");
  document.body.replaceChildren();
  for (const name of MARK_HOLD) document.documentElement.removeAttribute(name);
});

describe("the mark ticker", () => {
  it("seeks every mark forward by the time that passed, a pose at a time", () => {
    const ticker = createMarkTicker({ perSecond: 4, glideMs: 0 });
    const a = new FakeAnimation();
    const fast = new FakeAnimation(2);
    const stop = ticker.add(markWith([a, fast]));
    vi.advanceTimersByTime(249);
    expect(a.currentTime).toBe(0);
    vi.advanceTimersByTime(1);
    expect(a.currentTime).toBeCloseTo(250, 3);
    expect(fast.currentTime).toBeCloseTo(500, 3);
    stop();
  });

  it("runs one timer for every mark, and none once the last mark leaves", () => {
    const interval = vi.spyOn(window, "setInterval");
    const ticker = createMarkTicker({ perSecond: 4, glideMs: 0 });
    const one = ticker.add(markWith([new FakeAnimation()]));
    const two = ticker.add(markWith([new FakeAnimation()]));
    expect(interval).toHaveBeenCalledTimes(1);
    one();
    two();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on a hidden page and starts again from now, not with a catch-up jump", () => {
    const ticker = createMarkTicker({ perSecond: 4, glideMs: 0 });
    const a = new FakeAnimation();
    const stop = ticker.add(markWith([a]));
    setHidden(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(a.currentTime).toBe(0);
    setHidden(false);
    vi.advanceTimersByTime(250);
    expect(a.currentTime).toBeCloseTo(250, 3);
    stop();
  });

  it("draws no pose for a mark under a host's pause attribute, and stops when every mark is", async () => {
    const ticker = createMarkTicker({ perSecond: 4, glideMs: 0 });
    const app = document.createElement("div");
    document.body.append(app);
    const covered = new FakeAnimation();
    const free = new FakeAnimation();
    const stopCovered = ticker.add(markWith([covered], app));
    const stopFree = ticker.add(markWith([free]));
    app.setAttribute("data-app-covered", "");
    await observed();
    vi.advanceTimersByTime(250);
    expect(covered.currentTime).toBe(0);
    expect(free.currentTime).toBeCloseTo(250, 3);
    stopFree();
    expect(vi.getTimerCount()).toBe(0);
    app.removeAttribute("data-app-covered");
    await observed();
    expect(vi.getTimerCount()).toBe(1);
    document.documentElement.setAttribute("data-page-hidden", "");
    await observed();
    expect(vi.getTimerCount()).toBe(0);
    stopCovered();
  });

  it("never runs under prefers-reduced-motion", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches: query.includes("reduce"), addEventListener: () => {}, removeEventListener: () => {} }),
    });
    const ticker = createMarkTicker({ perSecond: 4, glideMs: 0 });
    const a = new FakeAnimation();
    const stop = ticker.add(markWith([a]));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(1000);
    expect(a.currentTime).toBe(0);
    stop();
  });

  it("eases a pose in over the glide, and lands it whole", () => {
    const ticker = createMarkTicker({ perSecond: 1, glideMs: 250 });
    const a = new FakeAnimation();
    const stop = ticker.add(markWith([a]));
    vi.advanceTimersByTime(1000 + 125);
    expect(a.currentTime).toBeGreaterThan(0);
    expect(a.currentTime).toBeLessThan(1000);
    vi.advanceTimersByTime(150);
    expect(a.currentTime).toBeCloseTo(1000, 3);
    stop();
  });

  // The ticker honours the host's pause attributes because the app's own rule pauses every animation
  // under them (index.css, issue 748). The two lists are one decision in two files; this pins them.
  it("names the same pause attributes the app's own rule pauses under", () => {
    const css = readFileSync(join(import.meta.dirname, "../index.css"), "utf-8");
    for (const name of MARK_HOLD) expect(css).toContain(`[${name}] *`);
  });

  it("refuses a rate that is not a positive number", () => {
    expect(() => createMarkTicker({ perSecond: 0, glideMs: 0 })).toThrow(/positive/);
  });
});
