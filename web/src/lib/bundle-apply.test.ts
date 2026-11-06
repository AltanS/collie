import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetBundleFocus,
  BUNDLE_FOCUS_TTL_MS,
  bundleApply,
  bundleFocusPending,
  requestBundleFocus,
  swControlled,
  subscribeBundleFocus,
  takeBundleFocus,
} from "./bundle-apply";

// The fact the mark, the dashboard's update line and the band all read, and the one-shot request a
// tap on the updating mark leaves for the dashboard.
describe("bundleApply — when the app on this phone is being applied", () => {
  it("is nothing on the app's FIRST install: a download with no worker in control replaces nothing", () => {
    expect(bundleApply({ bundleStale: false, stage: "installing", controlled: false })).toBeNull();
  });

  it("is the download on the automatic lane: no stale flag, but a worker in control (2026-11-06)", () => {
    expect(bundleApply({ bundleStale: false, stage: "installing", controlled: true })).toBe("installing");
  });

  it("is the band's two states whenever the self-updater's flag is up, controller or not", () => {
    expect(bundleApply({ bundleStale: true, stage: "installing", controlled: true })).toBe("installing");
    expect(bundleApply({ bundleStale: true, stage: "installing", controlled: false })).toBe("installing");
    expect(bundleApply({ bundleStale: true, stage: "idle", controlled: true })).toBe("ready");
    expect(bundleApply({ bundleStale: true, stage: "idle", controlled: false })).toBe("ready");
  });

  it("is nothing at rest, controller or not", () => {
    expect(bundleApply({ bundleStale: false, stage: "idle", controlled: true })).toBeNull();
    expect(bundleApply({ bundleStale: false, stage: "idle", controlled: false })).toBeNull();
  });
});

describe("swControlled", () => {
  afterEach(() => {
    // jsdom has no `navigator.serviceWorker`. Each case below defines it, configurable, and this
    // removes it again so no other case sees a worker.
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("is false with no service worker API at all (plain HTTP, jsdom)", () => {
    expect(swControlled()).toBe(false);
  });

  it("is false while nothing controls the page, and true once a worker does", () => {
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: null } });
    expect(swControlled()).toBe(false);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: {} } });
    expect(swControlled()).toBe(true);
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
