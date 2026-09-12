import { cacheClockNow, resetCacheClockForTests, subscribeCacheClock } from "./cache-clock";

// ONE interval for the document, and it must stop. Every case here is about cost rather than about
// what a chip says: a page with no chip on it pays nothing, a hidden tab pays nothing, and forty chips
// on one dashboard pay for one timer between them.

/** Fire a `visibilitychange` with `document.visibilityState` set. jsdom leaves it writable via define. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  resetCacheClockForTests();
  setVisibility("visible");
});

afterEach(() => {
  resetCacheClockForTests();
  vi.useRealTimers();
});

it("ticks its subscribers once a second", () => {
  const seen: number[] = [];
  const off = subscribeCacheClock(() => seen.push(cacheClockNow()));
  expect(seen).toHaveLength(0);
  vi.advanceTimersByTime(3000);
  expect(seen).toHaveLength(3);
  off();
});

it("shares ONE interval between every subscriber", () => {
  const a = vi.fn();
  const b = vi.fn();
  const c = vi.fn();
  const offs = [subscribeCacheClock(a), subscribeCacheClock(b), subscribeCacheClock(c)];
  vi.advanceTimersByTime(1000);
  // One tick, three calls. Three intervals would be three ticks each.
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).toHaveBeenCalledTimes(1);
  expect(c).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  for (const off of offs) off();
});

it("stops on the LAST unsubscribe, not the first", () => {
  const a = vi.fn();
  const offA = subscribeCacheClock(a);
  const offB = subscribeCacheClock(vi.fn());
  offA();
  vi.advanceTimersByTime(1000);
  expect(vi.getTimerCount()).toBe(1);
  offB();
  expect(vi.getTimerCount()).toBe(0);
});

it("pays nothing at all with nobody subscribed", () => {
  expect(vi.getTimerCount()).toBe(0);
});

it("stops while the document is hidden and resumes on return", () => {
  const fn = vi.fn();
  const off = subscribeCacheClock(fn);
  vi.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(1);

  setVisibility("hidden");
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(10_000);
  expect(fn).toHaveBeenCalledTimes(1);

  setVisibility("visible");
  // The clock is corrected on the way back IN, so the first repaint after a return is already true
  // rather than one second stale.
  expect(fn).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  off();
});

it("advances the clock it hands out", () => {
  const before = cacheClockNow();
  const off = subscribeCacheClock(() => {});
  vi.setSystemTime(new Date(Date.now() + 5000));
  vi.advanceTimersByTime(1000);
  expect(cacheClockNow()).toBeGreaterThan(before);
  off();
});
