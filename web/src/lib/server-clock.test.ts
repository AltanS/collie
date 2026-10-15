import { afterEach, describe, expect, it } from "vitest";

import { MAX_ROUND_TRIP_MS, noteServerDate, onBridgeClock, resetServerClockForTests, serverSkewMs } from "./server-clock";

// The bridge's clock as the phone estimates it, from the `Date` header of each response. The cases
// are the ones a wrong countdown on a permission card would come from: a phone ahead, a phone behind,
// a slow round trip, a header that is missing or not a time.

/** The bridge's clock, on a whole second, as the `Date` header can say it exactly. */
const BRIDGE = Date.UTC(2026, 9, 15, 10, 0, 0);
const FIVE_MIN = 5 * 60_000;

/** One response: the bridge stamped `bridgeAt`, the phone sent at `phoneSent` and heard back `rtt` later. */
function sample(bridgeAt: number, phoneSent: number, rtt = 40): void {
  noteServerDate(new Date(bridgeAt).toUTCString(), phoneSent, phoneSent + rtt);
}

afterEach(() => resetServerClockForTests());

describe("the bridge's clock", () => {
  it("is the phone's own clock until a sample arrives", () => {
    expect(serverSkewMs()).toBe(0);
    expect(onBridgeClock(1234)).toBe(1234);
  });

  it("a phone five minutes ahead reads the bridge's time, within the header's second", () => {
    sample(BRIDGE, BRIDGE + FIVE_MIN);
    expect(Math.abs(onBridgeClock(BRIDGE + FIVE_MIN) - BRIDGE)).toBeLessThan(1000);
  });

  it("a phone five minutes behind reads the bridge's time, within the header's second", () => {
    sample(BRIDGE, BRIDGE - FIVE_MIN);
    expect(Math.abs(onBridgeClock(BRIDGE - FIVE_MIN) - BRIDGE)).toBeLessThan(1000);
  });

  it("ignores a sample with a slow round trip", () => {
    sample(BRIDGE, BRIDGE + FIVE_MIN, MAX_ROUND_TRIP_MS + 1);
    expect(serverSkewMs()).toBe(0);
    sample(BRIDGE, BRIDGE + FIVE_MIN, MAX_ROUND_TRIP_MS);
    expect(serverSkewMs()).toBeLessThan(-FIVE_MIN + 1000);
  });

  it("ignores a missing header, a header that is not a time, and a round trip that ran backwards", () => {
    noteServerDate(null, BRIDGE, BRIDGE + 10);
    noteServerDate("soon", BRIDGE, BRIDGE + 10);
    noteServerDate(new Date(BRIDGE).toUTCString(), BRIDGE + FIVE_MIN, BRIDGE + FIVE_MIN - 10);
    expect(serverSkewMs()).toBe(0);
  });

  it("takes the median of the recent samples, so one odd sample does not move the clock", () => {
    sample(BRIDGE, BRIDGE + FIVE_MIN);
    sample(BRIDGE + 1000, BRIDGE + FIVE_MIN + 1000);
    sample(BRIDGE + 2000, BRIDGE + 2000 - 60 * 60_000); // one sample an hour off
    expect(Math.abs(onBridgeClock(BRIDGE + FIVE_MIN) - BRIDGE)).toBeLessThan(1000);
  });

  it("follows the phone when its clock is corrected: old samples age out", () => {
    for (let i = 0; i < 5; i++) sample(BRIDGE + i * 1000, BRIDGE + FIVE_MIN + i * 1000);
    for (let i = 5; i < 8; i++) sample(BRIDGE + i * 1000, BRIDGE + i * 1000);
    expect(serverSkewMs()).toBe(0);
  });

  it("reads an offset under the header's one second as none", () => {
    sample(BRIDGE, BRIDGE + 300);
    expect(serverSkewMs()).toBe(0);
  });
});
