import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetBundleFocus,
  BUNDLE_FOCUS_TTL_MS,
  bundleApply,
  bundleFocusPending,
  requestBundleFocus,
  subscribeBundleFocus,
  takeBundleFocus,
} from "./bundle-apply";

// The fact the mark, the dashboard's update line and the band all read, and the one-shot request a
// tap on the updating mark leaves for the dashboard.
describe("bundleApply — the band's two bundle states, as one fact", () => {
  it("is nothing while the bundle on screen is current, whatever the worker is doing", () => {
    // A worker installing with no stale flag is the app's first install, or the automatic lane
    // already reloading. The band said nothing about either, and neither does the mark.
    expect(bundleApply(false, "idle")).toBeNull();
    expect(bundleApply(false, "installing")).toBeNull();
  });

  it("is the download while the worker installs, and the waiting build otherwise", () => {
    expect(bundleApply(true, "installing")).toBe("installing");
    expect(bundleApply(true, "idle")).toBe("ready");
  });
});

describe("the one-shot request to show the update line", () => {
  afterEach(() => __resetBundleFocus());

  it("is taken exactly once", () => {
    requestBundleFocus(1_000);
    expect(bundleFocusPending()).toBe(true);
    expect(takeBundleFocus(1_500)).toBe(true);
    expect(bundleFocusPending()).toBe(false);
    expect(takeBundleFocus(1_600)).toBe(false);
  });

  it("expires, and an expired request is cleared rather than left for a later visit", () => {
    requestBundleFocus(1_000);
    expect(takeBundleFocus(1_000 + BUNDLE_FOCUS_TTL_MS + 1)).toBe(false);
    expect(bundleFocusPending()).toBe(false);
  });

  it("tells its subscribers on the request and on the take", () => {
    const heard = vi.fn();
    const off = subscribeBundleFocus(heard);
    requestBundleFocus(1_000);
    takeBundleFocus(1_000);
    off();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
