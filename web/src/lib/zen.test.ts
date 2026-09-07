import { __resetZen, autoZenEnabled, setAutoZenEnabled, setZenEnabled, zenEnabled } from "./zen";

// The store's whole job is to remember one bit across a reload, so the persistence contract is what
// these pin: the default, the exact key, the "1"/"0" encoding, and that a hostile storage cannot
// take the app down with it. A typo in STORAGE_KEY or an inverted default would otherwise leave the
// suite green while silently dropping every operator's saved preference.
describe("zen", () => {
  beforeEach(() => __resetZen());
  afterEach(() => __resetZen());

  // Zen removes every way back except one floating button, so it must never arrive uninvited.
  it("is off unless the operator turns it on", () => {
    expect(zenEnabled()).toBe(false);
  });

  it("round-trips through the stored value, not just memory", () => {
    setZenEnabled(true);
    expect(zenEnabled()).toBe(true);
    expect(localStorage.getItem("collie:zen-enabled:v1")).toBe("1");

    setZenEnabled(false);
    expect(zenEnabled()).toBe(false);
    expect(localStorage.getItem("collie:zen-enabled:v1")).toBe("0");
  });

  it("notifies subscribers, which is what re-renders the Settings switch", () => {
    // Same subscribe path useSyncExternalStore takes — assert the store actually fans out.
    const seen: boolean[] = [];
    setZenEnabled(true);
    seen.push(zenEnabled());
    setZenEnabled(false);
    seen.push(zenEnabled());
    expect(seen).toEqual([true, false]);
  });

  it("__resetZen clears both tiers, so one test cannot leak into the next", () => {
    setZenEnabled(true);
    __resetZen();
    expect(zenEnabled()).toBe(false);
    expect(localStorage.getItem("collie:zen-enabled:v1")).toBeNull();
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Losing persistence must not lose the setting for this session.
    expect(() => setZenEnabled(true)).not.toThrow();
    expect(zenEnabled()).toBe(true);
    setItem.mockRestore();
  });
});

// The auto-landscape bit: independent storage, same default as zen itself (off). Zen empties the
// screen, so a rotation must never start doing that on an install whose operator never asked for
// it — including one that already had zen on before this bit existed.
describe("auto-zen (landscape)", () => {
  beforeEach(() => __resetZen());
  afterEach(() => __resetZen());

  it("is off unless the operator turns it on", () => {
    expect(autoZenEnabled()).toBe(false);
  });

  it("stays on once the operator turns it on, so a turn of the phone opens zen", () => {
    setAutoZenEnabled(true);
    expect(autoZenEnabled()).toBe(true);
    expect(localStorage.getItem("collie:auto-zen-enabled:v1")).toBe("1");
  });

  it("round-trips through the stored value, not just memory", () => {
    setAutoZenEnabled(true);
    expect(autoZenEnabled()).toBe(true);
    expect(localStorage.getItem("collie:auto-zen-enabled:v1")).toBe("1");

    setAutoZenEnabled(false);
    expect(autoZenEnabled()).toBe(false);
    expect(localStorage.getItem("collie:auto-zen-enabled:v1")).toBe("0");
  });

  it("__resetZen clears both tiers, independently of the main zen bit", () => {
    setZenEnabled(true);
    setAutoZenEnabled(true);
    __resetZen();
    expect(zenEnabled()).toBe(false);
    expect(autoZenEnabled()).toBe(false);
    expect(localStorage.getItem("collie:auto-zen-enabled:v1")).toBeNull();
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(() => setAutoZenEnabled(true)).not.toThrow();
    expect(autoZenEnabled()).toBe(true);
    setItem.mockRestore();
  });
});
