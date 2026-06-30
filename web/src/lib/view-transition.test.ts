import { afterEach, describe, expect, it, vi } from "vitest";

import { markNavDirection, navigateWithTransition, viewTransition } from "./view-transition";

// jsdom ships no startViewTransition, so by default the helpers take their "unsupported" path. Each
// test that wants the animated path installs a mock that runs the callback synchronously, plus a
// matchMedia stub (jsdom has none) so the reduced-motion check can run.
function mockSupported({ reducedMotion = false } = {}) {
  const start = vi.fn((cb: () => void) => {
    cb();
    return { finished: Promise.resolve() };
  });
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = start;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reducedMotion })),
  );
  return start;
}

afterEach(() => {
  delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.vt;
  vi.unstubAllGlobals();
});

describe("viewTransition", () => {
  it("runs the update directly when the API is unavailable (no animation, no marker)", () => {
    const update = vi.fn();
    viewTransition("forward", update);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("marks the direction and runs the update through startViewTransition when supported", () => {
    const start = mockSupported();
    const update = vi.fn();
    viewTransition("forward", update);
    expect(start).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.vt).toBe("forward");
  });

  it("clears the marker for a lateral ('none') transition so the CSS falls back to a crossfade", () => {
    mockSupported();
    document.documentElement.dataset.vt = "forward"; // stale value from a prior move
    viewTransition("none", vi.fn());
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("skips the animation under prefers-reduced-motion (still applies the update)", () => {
    const start = mockSupported({ reducedMotion: true });
    const update = vi.fn();
    viewTransition("backward", update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });
});

describe("navigateWithTransition", () => {
  it("navigates plainly (no viewTransition flag) when the API is unavailable", () => {
    const navigate = vi.fn();
    navigateWithTransition(navigate, "/pane/x", "forward", { replace: true });
    expect(navigate).toHaveBeenCalledWith("/pane/x", { replace: true });
  });

  it("marks the direction and passes viewTransition: true when supported", () => {
    mockSupported();
    const navigate = vi.fn();
    navigateWithTransition(navigate, "/pane/x", "forward");
    expect(navigate).toHaveBeenCalledWith("/pane/x", { viewTransition: true });
    expect(document.documentElement.dataset.vt).toBe("forward");
  });

  it("preserves caller options alongside the viewTransition flag", () => {
    mockSupported();
    const navigate = vi.fn();
    navigateWithTransition(navigate, "/", "backward", { replace: true, state: { space: "w1" } });
    expect(navigate).toHaveBeenCalledWith("/", {
      replace: true,
      state: { space: "w1" },
      viewTransition: true,
    });
  });
});

describe("markNavDirection", () => {
  it("returns false and leaves no marker when unsupported", () => {
    expect(markNavDirection("forward")).toBe(false);
    expect(document.documentElement.dataset.vt).toBeUndefined();
  });

  it("returns true and sets the marker when supported", () => {
    mockSupported();
    expect(markNavDirection("forward")).toBe(true);
    expect(document.documentElement.dataset.vt).toBe("forward");
  });
});
