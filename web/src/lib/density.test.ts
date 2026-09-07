import { __resetDenseKeys, denseKeysEnabled, setDenseKeysEnabled } from "./density";

// The store's whole job is to remember one bit across a reload, so the persistence contract is what
// these pin: the default, the exact key, the "1"/"0" encoding, and that a hostile storage cannot
// take the app down with it. A typo in STORAGE_KEY or an inverted default would otherwise leave the
// suite green while silently relaying out every operator's phone.
describe("dense key surfaces", () => {
  beforeEach(() => __resetDenseKeys());
  afterEach(() => __resetDenseKeys());

  // The dense layout trades touch target size for keys per row, so it must never arrive uninvited.
  it("is off unless the operator turns it on", () => {
    expect(denseKeysEnabled()).toBe(false);
  });

  it("round-trips through the stored value, not just memory", () => {
    setDenseKeysEnabled(true);
    expect(denseKeysEnabled()).toBe(true);
    expect(localStorage.getItem("collie:dense-keys:v1")).toBe("1");

    setDenseKeysEnabled(false);
    expect(denseKeysEnabled()).toBe(false);
    expect(localStorage.getItem("collie:dense-keys:v1")).toBe("0");
  });

  it("__resetDenseKeys clears the stored bit, so one test cannot leak into the next", () => {
    setDenseKeysEnabled(true);
    __resetDenseKeys();
    expect(denseKeysEnabled()).toBe(false);
    expect(localStorage.getItem("collie:dense-keys:v1")).toBeNull();
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Losing persistence must not lose the setting for this session.
    expect(() => setDenseKeysEnabled(true)).not.toThrow();
    expect(denseKeysEnabled()).toBe(true);
    setItem.mockRestore();
  });
});
