import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate } from "@/lib/pwa";
import { __resetServerBuild, observeServerBuild } from "./server-build";
import { __resetReloadGuard, holdReload, releaseReload } from "./reload-guard";
import {
  __resetSelfUpdate,
  __setReloadImpl,
  selfUpdateBannerVisible,
  startSelfUpdate,
} from "./self-update";

// self-update's default update path calls lib/pwa's checkForUpdate (which reloads onto the fresh
// bundle on both SW and no-SW origins). Mock it so we never touch the real registration side effect
// or jsdom's throwing window.location.reload, and can assert the update path fired.
vi.mock("@/lib/pwa", () => ({
  checkForUpdate: vi.fn(),
}));

// BUILD.id under vitest is "test" (vitest.config `define`). Any other id reads as "stale".
const STALE = "0.13.0+new.1";

let stop: () => void;
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  __resetServerBuild();
  __resetReloadGuard();
  __resetSelfUpdate();
  stop = startSelfUpdate();
});
afterEach(() => stop());

describe("hysteresis — two consecutive stale observations required", () => {
  it("does NOT act on one differing observation, DOES on the second", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    observeServerBuild("test"); // matches BUILD.id → not stale
    observeServerBuild(STALE); // 1st stale sighting → pending, no action
    expect(reload).not.toHaveBeenCalled();
    observeServerBuild(STALE); // 2nd consecutive → confirmed → auto-reload (no SW, no hold)
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a single transient flip mid-deploy (id changes between polls) never triggers", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    observeServerBuild(STALE); // pending B
    observeServerBuild("0.13.0+other.2"); // a DIFFERENT stale id → pending resets, no confirm
    observeServerBuild("test"); // settles back to the current build → cleared
    expect(reload).not.toHaveBeenCalled();
    expect(selfUpdateBannerVisible()).toBe(false);
  });
});

describe("loop guard — auto-reload at most once per build id", () => {
  it("shows the banner instead of reloading when already auto-reloaded for this id", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    sessionStorage.setItem(`collie:auto-reloaded-for=${STALE}`, "1"); // pretend we already reloaded
    observeServerBuild(STALE);
    observeServerBuild(STALE); // confirmed, but already-reloaded → banner, NOT another reload
    expect(reload).not.toHaveBeenCalled();
    expect(selfUpdateBannerVisible()).toBe(true);
  });

  it("sets the sessionStorage guard when it does auto-reload", () => {
    __setReloadImpl(vi.fn());
    observeServerBuild(STALE);
    observeServerBuild(STALE);
    expect(sessionStorage.getItem(`collie:auto-reloaded-for=${STALE}`)).not.toBeNull();
  });
});

describe("safety gate — never reload over unsent work", () => {
  it("shows the banner while a hold is active, then auto-reloads when the hold clears", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("composer:w1:p1"); // e.g. unsent composer text
    observeServerBuild(STALE);
    observeServerBuild(STALE); // confirmed but held → banner, no reload
    expect(reload).not.toHaveBeenCalled();
    expect(selfUpdateBannerVisible()).toBe(true);

    releaseReload("composer:w1:p1"); // hold clears while still stale → reload now
    expect(reload).toHaveBeenCalledTimes(1);
    expect(selfUpdateBannerVisible()).toBe(false);
  });
});

describe("update path — fires regardless of service-worker presence (checkForUpdate handles both)", () => {
  it("invokes checkForUpdate exactly once on confirmation (the default, SW-agnostic update path)", () => {
    // No injected reloadImpl here — exercise the real default (() => checkForUpdate()).
    observeServerBuild(STALE);
    observeServerBuild(STALE);
    expect(vi.mocked(checkForUpdate)).toHaveBeenCalledTimes(1);
  });

  it("loop guard still holds with a SW in play: already-updated id → banner, checkForUpdate not called", () => {
    sessionStorage.setItem(`collie:auto-reloaded-for=${STALE}`, "1");
    observeServerBuild(STALE);
    observeServerBuild(STALE);
    expect(vi.mocked(checkForUpdate)).not.toHaveBeenCalled();
    expect(selfUpdateBannerVisible()).toBe(true);
  });
});
