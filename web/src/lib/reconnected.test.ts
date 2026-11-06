import {
  __resetReconnected,
  clearReconnected,
  reconnectedShowing,
  reconnects,
  showReconnected,
  subscribeReconnected,
} from "./reconnected";

describe("reconnects — when a change of the link is a reconnection the mark shows", () => {
  const at = { applying: false, dismissed: false };

  it("fires on amber → green", () => {
    expect(reconnects({ ...at, shown: "amber", next: null })).toBe(true);
  });

  it("fires on red → green", () => {
    expect(reconnects({ ...at, shown: "red", next: null })).toBe(true);
  });

  it("does not fire on a first paint that is already green: no bar was shown", () => {
    expect(reconnects({ ...at, shown: null, next: null })).toBe(false);
  });

  it("does not fire on green → green: the latch cleared on the recovery that fired", () => {
    expect(reconnects({ ...at, shown: null, next: null })).toBe(false);
  });

  it("does not fire while a bar is still up, amber → red included", () => {
    expect(reconnects({ ...at, shown: "amber", next: "red" })).toBe(false);
    expect(reconnects({ ...at, shown: null, next: "amber" })).toBe(false);
  });

  it("is skipped while the app is being applied: the update colour wins", () => {
    expect(reconnects({ shown: "amber", next: null, applying: true, dismissed: false })).toBe(false);
    expect(reconnects({ shown: "red", next: null, applying: true, dismissed: false })).toBe(false);
  });

  it("is skipped after the operator dismissed the red strip: they asked for quiet", () => {
    expect(reconnects({ shown: "red", next: null, applying: false, dismissed: true })).toBe(false);
  });
});

describe("the reconnected store — one turn, then rest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReconnected();
  });
  afterEach(() => {
    __resetReconnected();
    vi.useRealTimers();
  });

  it("shows for exactly the time it was given, then goes", () => {
    showReconnected(1_800);
    expect(reconnectedShowing()).toBe(true);
    vi.advanceTimersByTime(1_799);
    expect(reconnectedShowing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reconnectedShowing()).toBe(false);
  });

  it("ends early on a clear, and a later timer does not bring it back", () => {
    showReconnected(1_800);
    clearReconnected();
    expect(reconnectedShowing()).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(reconnectedShowing()).toBe(false);
  });

  it("tells its subscribers on, and again on off", () => {
    const seen: boolean[] = [];
    const stop = subscribeReconnected(() => seen.push(reconnectedShowing()));
    showReconnected(1_800);
    vi.advanceTimersByTime(1_800);
    stop();
    expect(seen).toEqual([true, false]);
  });
});
