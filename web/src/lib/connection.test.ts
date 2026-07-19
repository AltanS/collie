import { isConnecting } from "./connection";

describe("isConnecting (poll-truth — navigator.onLine is never an input)", () => {
  it("is false when the snapshot path is healthy (data is live)", () => {
    expect(isConnecting({ bridge: "connected", error: false })).toBe(false);
  });

  it("has no onLine gate at all — a healthy snapshot stays live no matter what the browser claims", () => {
    // Regression guard: onLine used to force isConnecting true. It's gone from ConnState now, so a
    // phone whose onLine flag lies (airplane-mode stuck true, OR stuck false after an airplane cycle
    // while the network is actually fine) can't manufacture a phantom outage while polls succeed. The
    // signature literally has no `online` to pass — a healthy snapshot is the only thing that matters.
    expect(isConnecting({ bridge: "connected", error: false })).toBe(false);
  });

  it("is true on a fetch error, before the first snapshot, and when Herdr is disconnected", () => {
    expect(isConnecting({ bridge: "connected", error: true })).toBe(true);
    expect(isConnecting({ bridge: undefined, error: false })).toBe(true);
    expect(isConnecting({ bridge: "disconnected", error: false })).toBe(true);
  });

  it("is true when a load has stalled, even while connected/error-free", () => {
    // A stall is an in-flight fetch that hasn't settled — nothing has failed yet, but the data on
    // screen isn't live, so the Collie mark should gallop.
    expect(isConnecting({ bridge: "connected", error: false, stalled: true })).toBe(true);
  });
});
