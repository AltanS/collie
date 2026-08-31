import {
  __resetStripsCollapsed,
  setStripsCollapsed,
  stripsCollapsed,
} from "./strips-collapsed";

// The store's whole job is to remember one bit across a reload, so the persistence contract is what
// these pin: the default, the exact key, the "1"/"0" encoding, and that a hostile storage cannot
// take the app down with it. A typo in STORAGE_KEY or an inverted default would otherwise leave the
// suite green while silently dropping every operator's saved preference — and here the inverted
// default is the loud one: it hides the pane screen's only visible way to reach a sibling tab.
describe("strips-collapsed", () => {
  beforeEach(() => __resetStripsCollapsed());
  afterEach(() => __resetStripsCollapsed());

  it("shows the rows unless the operator folded them", () => {
    expect(stripsCollapsed()).toBe(false);
  });

  it("round-trips through the stored value, not just memory", () => {
    setStripsCollapsed(true);
    expect(stripsCollapsed()).toBe(true);
    expect(localStorage.getItem("collie:strips-collapsed:v1")).toBe("1");

    setStripsCollapsed(false);
    expect(stripsCollapsed()).toBe(false);
    expect(localStorage.getItem("collie:strips-collapsed:v1")).toBe("0");
  });

  it("does not share zen's key — two independent preferences, two rows in storage", () => {
    // Both are device-level booleans written the same way, so a copy-paste of the key would leave
    // turning zen on silently folding the strips of every pane after it.
    setStripsCollapsed(true);
    expect(localStorage.getItem("collie:zen-enabled:v1")).toBeNull();
  });

  it("notifies subscribers, which is what re-renders the pane's chrome", () => {
    // Same subscribe path useSyncExternalStore takes — assert the store actually fans out.
    const seen: boolean[] = [];
    setStripsCollapsed(true);
    seen.push(stripsCollapsed());
    setStripsCollapsed(false);
    seen.push(stripsCollapsed());
    expect(seen).toEqual([true, false]);
  });

  it("__resetStripsCollapsed clears both tiers, so one test cannot leak into the next", () => {
    setStripsCollapsed(true);
    __resetStripsCollapsed();
    expect(stripsCollapsed()).toBe(false);
    expect(localStorage.getItem("collie:strips-collapsed:v1")).toBeNull();
  });

  it("survives a storage that throws on write (Safari private mode)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    // Losing persistence must not lose the setting for this session.
    expect(() => setStripsCollapsed(true)).not.toThrow();
    expect(stripsCollapsed()).toBe(true);
    setItem.mockRestore();
  });
});
