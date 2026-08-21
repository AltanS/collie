import { describe, expect, it } from "bun:test";

import {
  compareSemver,
  githubReleaseUrl,
  latestReleaseAboveMajor,
  latestReleaseInMajor,
  latestReleaseTag,
  majorOf,
  parseSemverTag,
  shouldNotify,
  stampOf,
  UpdateMonitor,
  type UpdateMonitorDeps,
  type UpdateStore,
} from "./update.ts";

describe("compareSemver", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareSemver("0.11.0", "0.12.0")).toBe(-1);
    expect(compareSemver("0.12.0", "0.11.0")).toBe(1);
    expect(compareSemver("1.0.0", "0.99.99")).toBe(1);
    expect(compareSemver("0.11.0", "0.11.0")).toBe(0);
    expect(compareSemver("0.11.2", "0.11.10")).toBe(-1); // numeric, not lexical
  });

  it("sorts a prerelease below the release it leads to", () => {
    // The running version can be `1.0.0-beta.5` while every tag is strict, so the tail must be
    // parsed rather than handed to `Number` (which yielded NaN and an arbitrary answer).
    expect(compareSemver("1.0.0-beta.5", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-beta.5")).toBe(1);
    expect(compareSemver("1.0.0-beta.5", "0.31.1")).toBe(1);
    expect(compareSemver("1.0.0-beta.5+ab12cd3", "1.0.1")).toBe(-1);
  });
});

describe("majorOf / latestReleaseInMajor / latestReleaseAboveMajor", () => {
  const tags = ["v0.31.1", "v0.32.0", "v1.0.0", "v1.1.0", "v1.1.0-rc.1", "v2.0.0", "nightly"];

  it("reads the major off a version, prerelease and build metadata included", () => {
    expect(majorOf("1.0.0-beta.5+ab12cd3")).toBe(1);
    expect(majorOf("0.31.1")).toBe(0);
    expect(majorOf("unknown")).toBeNull();
  });

  it("keeps the routine target inside the running major", () => {
    expect(latestReleaseInMajor(tags, 0)).toBe("0.32.0");
    expect(latestReleaseInMajor(tags, 1)).toBe("1.1.0"); // the rc is invisible, as everywhere
    expect(latestReleaseInMajor(tags, 3)).toBeNull();
  });

  it("reports a higher major separately — announcing it is not taking it", () => {
    expect(latestReleaseAboveMajor(tags, 0)).toBe("2.0.0");
    expect(latestReleaseAboveMajor(tags, 1)).toBe("2.0.0");
    expect(latestReleaseAboveMajor(tags, 2)).toBeNull();
  });
});

describe("parseSemverTag / latestReleaseTag", () => {
  it("accepts strict vX.Y.Z, rejects prereleases and junk", () => {
    expect(parseSemverTag("v0.11.0")).toEqual([0, 11, 0]);
    expect(parseSemverTag(" v1.2.3 ")).toEqual([1, 2, 3]);
    expect(parseSemverTag("v1.0.0-rc.1")).toBeNull();
    expect(parseSemverTag("0.11.0")).toBeNull(); // no leading v
    expect(parseSemverTag("latest")).toBeNull();
  });

  it("picks the max release and strips the leading v", () => {
    expect(latestReleaseTag(["v0.10.3", "v0.11.0", "v0.9.0"])).toBe("0.11.0");
    // Non-release refs and prereleases are ignored, not chosen.
    expect(latestReleaseTag(["v0.11.0", "v0.12.0-beta.1", "nightly"])).toBe("0.11.0");
    expect(latestReleaseTag([])).toBeNull();
    expect(latestReleaseTag(["main", "v1.0.0-rc"])).toBeNull();
  });
});

describe("shouldNotify", () => {
  const current = "0.11.0";
  it("fires only for a strictly-newer, not-yet-notified release", () => {
    expect(shouldNotify({ current, latest: "0.12.0", lastNotified: null })).toBe(true);
    // Already notified for this exact version → no re-nag.
    expect(shouldNotify({ current, latest: "0.12.0", lastNotified: "0.12.0" })).toBe(false);
    // A newer one than we last notified → fire again.
    expect(shouldNotify({ current, latest: "0.13.0", lastNotified: "0.12.0" })).toBe(true);
    // Not newer than what we're running → never.
    expect(shouldNotify({ current, latest: "0.11.0", lastNotified: null })).toBe(false);
    expect(shouldNotify({ current, latest: "0.10.0", lastNotified: null })).toBe(false);
    expect(shouldNotify({ current, latest: null, lastNotified: null })).toBe(false);
  });
});

describe("stampOf", () => {
  it("is order-independent and changes on any mtime/size change", () => {
    const a = [
      { path: "b.ts", mtimeMs: 2, size: 20 },
      { path: "a.ts", mtimeMs: 1, size: 10 },
    ];
    const b = [
      { path: "a.ts", mtimeMs: 1, size: 10 },
      { path: "b.ts", mtimeMs: 2, size: 20 },
    ];
    expect(stampOf(a)).toBe(stampOf(b)); // same set, different order → same stamp
    expect(stampOf(a)).not.toBe(stampOf([{ path: "a.ts", mtimeMs: 9, size: 10 }, { path: "b.ts", mtimeMs: 2, size: 20 }]));
    expect(stampOf(a)).not.toBe(stampOf([{ path: "a.ts", mtimeMs: 1, size: 99 }, { path: "b.ts", mtimeMs: 2, size: 20 }]));
  });
});

// A fake store + a scripted clock for the monitor.
function fakeStore(initial: string | null = null): UpdateStore & { saved: string[] } {
  let last = initial;
  const saved: string[] = [];
  return {
    saved,
    lastNotified: () => last,
    setLastNotified: async (v) => {
      last = v;
      saved.push(v);
    },
  };
}

function makeMonitor(over: Partial<UpdateMonitorDeps> = {}) {
  const notified: string[] = [];
  const store = fakeStore();
  let clock = 1_000_000;
  const monitor = new UpdateMonitor({
    repo: "AltanS/collie",
    current: "0.11.0",
    startupStamp: "STAMP@boot",
    fetchTags: async () => ["v0.12.0"],
    bridgeStamp: () => "STAMP@boot",
    store,
    now: () => clock,
    updatesEnabled: () => true,
    notify: (v) => notified.push(v),
    ...over,
  });
  return { monitor, notified, store, tick: (ms: number) => (clock += ms) };
}

describe("UpdateMonitor", () => {
  it("surfaces releaseAvailable + latest + latestUrl after a successful check", async () => {
    // Use a REAL Collie release (v0.10.3) with `current` below it, so the asserted release URL exists.
    const { monitor } = makeMonitor({
      current: "0.9.0",
      fetchTags: async () => ["v0.2.0", "v0.10.0", "v0.10.3"],
    });
    expect(monitor.status()).toMatchObject({ current: "0.9.0", latest: null, latestUrl: null, releaseAvailable: false, checkedAt: null });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "0.10.3",
      latestUrl: "https://github.com/AltanS/collie/releases/tag/v0.10.3",
      releaseAvailable: true,
    });
    expect(monitor.status().checkedAt).not.toBeNull();
  });

  it("splits the answer: the newest release of MY major, and a higher major named apart from it", async () => {
    // The banner has to say WHICH kind of behind you are (ADR 0020) — a routine update fixes one and
    // refuses the other, so one field could not carry both.
    const { monitor } = makeMonitor({
      current: "0.31.1",
      fetchTags: async () => ["v0.31.1", "v0.32.0", "v1.0.0", "v1.0.1"],
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "0.32.0",
      releaseAvailable: true,
      majorAvailable: "1.0.1",
      majorUrl: "https://github.com/AltanS/collie/releases/tag/v1.0.1",
    });
  });

  it("a 1.x install sees only 1.x releases, and no major above it", async () => {
    const { monitor } = makeMonitor({
      current: "1.0.0-beta.5",
      fetchTags: async () => ["v0.32.0", "v1.0.0"],
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "1.0.0", // the beta is behind its own release
      releaseAvailable: true,
      majorAvailable: null,
      majorUrl: null,
    });
  });

  it("githubReleaseUrl reconstructs the vX.Y.Z tag page", () => {
    expect(githubReleaseUrl("AltanS/collie", "0.10.3")).toBe(
      "https://github.com/AltanS/collie/releases/tag/v0.10.3",
    );
  });

  it("fires the push exactly once per new version, persisting BEFORE notifying", async () => {
    const order: string[] = [];
    const store = fakeStore();
    const wrapped: UpdateStore = {
      lastNotified: store.lastNotified,
      setLastNotified: async (v) => {
        order.push(`persist:${v}`);
        await store.setLastNotified(v);
      },
    };
    const { monitor, notified } = makeMonitor({ store: wrapped, notify: (v) => order.push(`notify:${v}`) });
    await monitor.checkRelease();
    await monitor.checkRelease(); // same latest → no re-nag
    expect(order).toEqual(["persist:0.12.0", "notify:0.12.0"]); // persisted first, fired once
    expect(notified).toEqual([]); // notify routed into `order` above
  });

  it("does not push when the updates pref is off, but still surfaces releaseAvailable", async () => {
    const { monitor, notified } = makeMonitor({ updatesEnabled: () => false });
    await monitor.checkRelease();
    expect(notified).toEqual([]);
    expect(monitor.status().releaseAvailable).toBe(true); // the banner still shows; only the push is gated
  });

  it("is fail-soft: a fetch error keeps prior state and sends nothing", async () => {
    const { monitor, notified } = makeMonitor({
      fetchTags: async () => {
        throw new Error("network down");
      },
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({ latest: null, releaseAvailable: false, checkedAt: null });
    expect(notified).toEqual([]);
  });

  it("does not notify when latest is not newer than current", async () => {
    const { monitor, notified } = makeMonitor({ fetchTags: async () => ["v0.11.0", "v0.10.0"] });
    await monitor.checkRelease();
    expect(monitor.status().releaseAvailable).toBe(false);
    expect(notified).toEqual([]);
  });

  it("de-dupes concurrent checks — one fetch backs both callers, then the guard clears", async () => {
    let calls = 0;
    let release!: (tags: string[]) => void;
    const gate = new Promise<string[]>((r) => {
      release = r;
    });
    const { monitor } = makeMonitor({
      fetchTags: () => {
        calls++;
        return gate;
      },
    });
    const a = monitor.checkRelease();
    const b = monitor.checkRelease(); // lands while the first is still in flight → same promise
    release(["v0.12.0"]);
    await Promise.all([a, b]);
    expect(calls).toBe(1); // NOT two hits on the API
    expect(monitor.status().latest).toBe("0.12.0");

    await monitor.checkRelease(); // guard cleared → a later check fetches afresh
    expect(calls).toBe(2);
  });

  it("reports bridgeStale when the on-disk stamp diverges from the boot stamp (throttled)", async () => {
    let disk = "STAMP@boot";
    const { monitor, tick } = makeMonitor({ bridgeStamp: () => disk });
    expect(monitor.status().bridgeStale).toBe(false);
    disk = "STAMP@rebuilt";
    // Within the throttle window the cached value stands...
    expect(monitor.status().bridgeStale).toBe(false);
    tick(6_000); // ...past it, the recompute sees the divergence.
    expect(monitor.status().bridgeStale).toBe(true);
  });
});
