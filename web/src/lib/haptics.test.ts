import { __resetHaptics, buzz, hapticsEnabled, hapticsSupported, setHapticsEnabled } from "./haptics";

// The platform gate IS the optional call — these pin that a device without vibrate is a silent
// no-op rather than a crash, and that the preference actually gates the buzz.
describe("haptics", () => {
  let vibrate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetHaptics();
    vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", {
      value: vibrate,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "vibrate");
    __resetHaptics();
  });

  it("is on by default and buzzes", () => {
    expect(hapticsEnabled()).toBe(true);
    buzz();
    expect(vibrate).toHaveBeenCalledOnce();
  });

  it("stays silent once disabled, and resumes when re-enabled", () => {
    setHapticsEnabled(false);
    buzz();
    expect(vibrate).not.toHaveBeenCalled();

    setHapticsEnabled(true);
    // Re-enabling confirms itself with the thing the setting does.
    expect(vibrate).toHaveBeenCalled();
    vibrate.mockClear();
    buzz();
    expect(vibrate).toHaveBeenCalledOnce();
  });

  it("persists the preference", () => {
    setHapticsEnabled(false);
    expect(localStorage.getItem("collie:haptics:v1")).toBe("0");
  });

  // iOS Safari: navigator.vibrate is simply undefined. The optional call must swallow it, and the
  // Settings row hides itself rather than offering a toggle that provably does nothing.
  it("no-ops where the platform has no vibrate, and reports itself unsupported", () => {
    Reflect.deleteProperty(navigator as unknown as Record<string, unknown>, "vibrate");
    expect(hapticsSupported()).toBe(false);
    expect(() => buzz()).not.toThrow();
  });

  it("never lets a throwing vibrate break the caller — a missing buzz is not an error", () => {
    vibrate.mockImplementation(() => {
      throw new Error("blocked by permissions policy");
    });
    expect(() => buzz()).not.toThrow();
  });
});
