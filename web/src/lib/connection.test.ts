import { isConnecting } from "./connection";

describe("isConnecting", () => {
  it("is false only when online, connected, and error-free (data is live)", () => {
    expect(isConnecting({ online: true, bridge: "connected", error: false })).toBe(false);
  });

  it("is true while offline, regardless of bridge state", () => {
    expect(isConnecting({ online: false, bridge: "connected", error: false })).toBe(true);
  });

  it("is true on a fetch error, before the first snapshot, and when Herdr is disconnected", () => {
    expect(isConnecting({ online: true, bridge: "connected", error: true })).toBe(true);
    expect(isConnecting({ online: true, bridge: undefined, error: false })).toBe(true);
    expect(isConnecting({ online: true, bridge: "disconnected", error: false })).toBe(true);
  });
});
