import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate } from "@/lib/pwa";
import { __resetServerBuild, observeServerBuild } from "./server-build";
import { __resetReloadGuard, holdReload, releaseReload } from "./reload-guard";
import {
  __resetSelfUpdate,
  __setReloadImpl,
  noteUpdateRun,
  selfUpdateBannerVisible,
  startSelfUpdate,
  subscribeBanner,
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

describe("__resetSelfUpdate notifies subscribers", () => {
  it("notifies when the reset changes the banner's visibility", () => {
    // Pins the fix: __resetSelfUpdate used to assign `banner = false` directly instead of going
    // through setBanner, so a subscriber (a component driven by useSelfUpdate/useSyncExternalStore)
    // never repainted when a reset hid a visible banner.
    holdReload("composer:w1:p1");
    observeServerBuild(STALE);
    observeServerBuild(STALE); // confirmed but held → banner visible
    expect(selfUpdateBannerVisible()).toBe(true);

    let hits = 0;
    const unsub = subscribeBanner(() => hits++);
    __resetSelfUpdate();
    expect(selfUpdateBannerVisible()).toBe(false);
    expect(hits).toBe(1);
    unsub();
    releaseReload("composer:w1:p1");
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

// ── The Collie-update hold (M15/05) ─────────────────────────────────────────────────────────────
//
// A Collie update restarts the bridge, which changes the server build id — the exact signal this
// module reloads on. That reload is right, and only once the run is over. Mid-run it lands the
// operator on a page that cannot reach the bridge, which is why the coordination is explicit rather
// than left to timing.
describe("self-update hold — a Collie update run defers the bundle reload", () => {
  it("does not reload while the run is in flight, and does the moment it is done", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);

    noteUpdateRun("restarting");
    observeServerBuild(STALE);
    observeServerBuild(STALE); // confirmed stale — and held
    expect(reload).not.toHaveBeenCalled();
    expect(selfUpdateBannerVisible()).toBe(true);

    // `done` clears the hold, and the deferred reload fires without waiting for another poll: the
    // new bundle is exactly what the operator should land on.
    noteUpdateRun("done");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("holds through every in-flight state and through none of the terminal ones", () => {
    for (const state of ["preflight", "staging", "restarting", "verifying"]) {
      const reload = vi.fn();
      __resetSelfUpdate(); // resets the reload impl too, so the spy goes in AFTER it
      __setReloadImpl(reload);
      sessionStorage.clear();
      noteUpdateRun(state);
      observeServerBuild(STALE);
      observeServerBuild(STALE);
      expect(reload).not.toHaveBeenCalled();
    }
    for (const state of ["done", "rolled-back", "stuck", "interrupted", "idle", undefined]) {
      const reload = vi.fn();
      __resetSelfUpdate(); // resets the reload impl too, so the spy goes in AFTER it
      __setReloadImpl(reload);
      sessionStorage.clear();
      noteUpdateRun(state);
      observeServerBuild(STALE);
      observeServerBuild(STALE);
      expect(reload).toHaveBeenCalledTimes(1);
    }
    noteUpdateRun(undefined);
  });

  it("composes with the other holds rather than replacing them — an unsent draft still defers", () => {
    const reload = vi.fn();
    __setReloadImpl(reload);
    holdReload("composer");
    noteUpdateRun("done"); // the update's own hold is clear…
    observeServerBuild(STALE);
    observeServerBuild(STALE);
    expect(reload).not.toHaveBeenCalled(); // …and the composer's is not
    releaseReload("composer");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
