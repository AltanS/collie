import {
  __resetTourStore,
  TOUR_STORAGE_KEY,
  markTourSeen,
  resetTour,
  shouldShowTour,
  tourSeenVersion,
  TOUR_VERSION,
} from "./tour";

// The first-launch tour's per-device store. The whole gate is `shouldShowTour(seen)`, so the value
// in storage has to be a number the app can compare — never a boolean, never JSON.

/** Re-import the module with storage already seeded, since `load()` runs once at module scope. */
async function loadWith(raw: string | null) {
  vi.resetModules();
  if (raw === null) localStorage.removeItem(TOUR_STORAGE_KEY);
  else localStorage.setItem(TOUR_STORAGE_KEY, raw);
  return await import("./tour");
}

describe("tour store", () => {
  beforeEach(() => __resetTourStore());
  afterEach(() => __resetTourStore());

  it("starts unseen, so a fresh device is shown the tour", () => {
    expect(tourSeenVersion()).toBe(0);
    expect(shouldShowTour(tourSeenVersion())).toBe(true);
  });

  it("marks the tour seen at this bundle's version, as a bare decimal string", () => {
    markTourSeen();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe(String(TOUR_VERSION));
    expect(tourSeenVersion()).toBe(TOUR_VERSION);
    expect(shouldShowTour(tourSeenVersion())).toBe(false);
  });

  it("writes zero on reset rather than removing the key", () => {
    markTourSeen();
    resetTour();
    expect(localStorage.getItem(TOUR_STORAGE_KEY)).toBe("0");
    expect(shouldShowTour(tourSeenVersion())).toBe(true);
  });

  // The bump rule: a device that saw an older tour is shown the new one exactly once.
  it("shows the tour again once the version is bumped past what the device saw", () => {
    expect(shouldShowTour(TOUR_VERSION - 1)).toBe(true);
    expect(shouldShowTour(TOUR_VERSION)).toBe(false);
    expect(shouldShowTour(TOUR_VERSION + 1)).toBe(false);
  });

  it("reads an unparseable, empty or negative value as never-seen", async () => {
    for (const raw of ["", "yes", "{\"v\":1}", "-3"]) {
      const mod = await loadWith(raw);
      expect(mod.tourSeenVersion()).toBe(0);
    }
  });

  it("reads a stored version back after a reload", async () => {
    const mod = await loadWith("1");
    expect(mod.tourSeenVersion()).toBe(1);
  });

  it("notifies subscribers so the host repaints when the tour is reset", () => {
    // useSyncExternalStore's subscribe is module-private; the observable effect is the same one the
    // Settings row depends on — a write reaches a reader that already read the old value.
    markTourSeen();
    const before = tourSeenVersion();
    resetTour();
    expect(before).not.toBe(tourSeenVersion());
  });
});
