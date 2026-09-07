import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "./config.ts";

import {
  type ApiTag,
  compareSemver,
  followsTrain,
  githubReleaseUrl,
  isPrereleaseVersion,
  latestUpdateInMajor,
  latestReleaseAboveMajor,
  latestReleaseInMajor,
  latestReleaseTag,
  majorOf,
  parsePrereleaseTag,
  parseReleaseManifest,
  parseSemverTag,
  parseTagsResponse,
  restartCommandFor,
  shouldNotify,
  stampOf,
  updateDigestBody,
  updatesNewerThan,
  UpdateMonitor,
  type UpdateMonitorDeps,
  UpdateStateStore,
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

  it("orders prerelease tails by semver §11 — the whole beta train, in order", () => {
    // The chain a beta install walks. `beta.9` vs `beta.10` used to compare EQUAL (the tail was
    // reduced to a boolean), which would have frozen the train at its first two-digit beta.
    const chain = ["1.0.0-beta.9", "1.0.0-beta.10", "1.0.0-rc.1", "1.0.0"];
    for (let i = 0; i + 1 < chain.length; i++) {
      expect(compareSemver(chain[i]!, chain[i + 1]!)).toBe(-1);
      expect(compareSemver(chain[i + 1]!, chain[i]!)).toBe(1);
    }
    // Numeric identifiers sort BELOW alphanumeric ones, and a shorter tail that is a prefix of a
    // longer one sorts first.
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemver("1.0.0-beta.44", "1.0.0-beta.44")).toBe(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-beta.1")).toBe(-1);
  });
});

describe("parsePrereleaseTag / isPrereleaseVersion", () => {
  it("accepts vX.Y.Z and vX.Y.Z-<tail>, and keeps the tail apart", () => {
    expect(parsePrereleaseTag("v1.2.3")).toEqual({ triple: [1, 2, 3], prerelease: null });
    expect(parsePrereleaseTag(" v1.0.0-beta.44 ")).toEqual({ triple: [1, 0, 0], prerelease: "beta.44" });
    expect(parsePrereleaseTag("v1.0.0-rc.1")).toEqual({ triple: [1, 0, 0], prerelease: "rc.1" });
  });

  it("rejects garbage — remote ref names are untrusted input", () => {
    expect(parsePrereleaseTag("v1.0.0-")).toBeNull(); // a bare trailing hyphen names no tail
    expect(parsePrereleaseTag("v1.0.0-beta..1")).toBeNull(); // an empty identifier
    expect(parsePrereleaseTag("refs/tags/v1.0.0-beta.1")).toBeNull(); // slashes never survive
    expect(parsePrereleaseTag("v1.0.0-beta.1/x")).toBeNull();
    expect(parsePrereleaseTag("v1.0.0-beta.1^{}")).toBeNull();
    expect(parsePrereleaseTag("1.0.0-beta.1")).toBeNull(); // no leading v
    expect(parsePrereleaseTag("v1.0-beta.1")).toBeNull();
    expect(parsePrereleaseTag("nightly")).toBeNull();
    // The STRICT parser is unchanged — it still means "strict releases only".
    expect(parseSemverTag("v1.0.0-beta.44")).toBeNull();
  });

  it("reads prerelease-following off the installed version, never off a flag", () => {
    expect(isPrereleaseVersion("1.0.0-beta.44")).toBe(true);
    expect(isPrereleaseVersion("1.0.0")).toBe(false);
    expect(isPrereleaseVersion("0.32.0")).toBe(false);
    expect(isPrereleaseVersion("unknown")).toBe(false);
  });
});

describe("followsTrain / latestUpdateInMajor", () => {
  const tags = ["v0.32.0", "v1.0.0-beta.9", "v1.0.0-beta.10", "v1.0.0-rc.1", "v1.0.0", "nightly"];

  it("the train is a FALLBACK, never a preference", () => {
    expect(followsTrain("1.0.0", "1.0.0")).toBe(false); // stable install: never
    expect(followsTrain("1.0.0", null)).toBe(false);
    expect(followsTrain("1.0.0-beta.44", null)).toBe(true); // no strict release of the major at all
    expect(followsTrain("1.0.0-beta.44", "1.0.0")).toBe(false); // a strict release is out → take it
    expect(followsTrain("1.0.0-rc.1", "0.32.0")).toBe(true); // that strict one is not of this major
    expect(followsTrain("1.0.0-beta.44", "1.0.0-beta.44")).toBe(true); // not newer than installed
  });

  it("a STABLE install never sees a prerelease — the regression this must not lose", () => {
    // Only newer prereleases exist above it, and it is offered none of them.
    const betasOnly = ["v1.0.0", "v1.1.0-beta.1", "v1.1.0-beta.2"];
    expect(latestUpdateInMajor(betasOnly, 1, "1.0.0")).toBe("1.0.0");
    expect(latestUpdateInMajor(tags, 0, "0.32.0")).toBe("0.32.0");
    // Identical to the strict resolver, by construction.
    expect(latestUpdateInMajor(tags, 1, "1.0.0")).toBe(latestReleaseInMajor(tags, 1));
  });

  it("a PRERELEASE install takes the train only while no strict release of its major is newer", () => {
    // Fallback: nothing strict published in major 1 yet → the next beta.
    expect(latestUpdateInMajor(["v1.0.0-beta.44", "v1.0.0-beta.45"], 1, "1.0.0-beta.44")).toBe("1.0.0-beta.45");
    // Supersede: once v1.0.0 exists it wins, and beta.45 is skipped entirely.
    expect(latestUpdateInMajor(["v1.0.0-beta.45", "v1.0.0"], 1, "1.0.0-beta.44")).toBe("1.0.0");
    // The consent was to the road TO the release, not to the major's prereleases forever: a LATER
    // minor's rc is as invisible to a beta install as it is to a stable one.
    expect(latestUpdateInMajor(["v1.0.0", "v1.1.0-rc.1"], 1, "1.0.0-beta.5")).toBe("1.0.0");
    expect(latestUpdateInMajor(tags, 1, "1.0.0-beta.10")).toBe("1.0.0");
    // …and it never crosses out of its own major.
    expect(latestUpdateInMajor(["v0.32.0", "v2.0.0"], 1, "1.0.0-beta.1")).toBeNull();
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

// 10:00 on a fixed LOCAL day — past the digest's earliest hour, so a test that isn't about the clock
// isn't accidentally about the clock. Built from local parts, so it holds in any TZ.
const AT_10AM = new Date(2026, 0, 15, 10, 0, 0);
const hoursAgo = (from: Date, h: number) => new Date(from.getTime() - h * 3600_000).toISOString();

describe("updatesNewerThan", () => {
  it("lists every version this install may take, oldest first — the digest names them all", () => {
    expect(updatesNewerThan(["v0.11.0", "v0.12.0", "v0.12.1", "v1.0.0", "nightly"], "0.11.0")).toEqual([
      "0.12.0",
      "0.12.1",
    ]);
    // A stable install stays blind to prereleases; a beta install follows its own train.
    expect(updatesNewerThan(["v1.0.0", "v1.1.0-beta.1"], "1.0.0")).toEqual([]);
    expect(updatesNewerThan(["v1.0.0-beta.44", "v1.0.0-beta.45"], "1.0.0-beta.44")).toEqual([
      "1.0.0-beta.45",
    ]);
  });
});

describe("updateDigestBody", () => {
  it("names the one version, or the count AND every folded version", () => {
    expect(updateDigestBody("1.3.0", ["1.3.1"])).toBe("Collie 1.3.1 is available");
    expect(updateDigestBody("1.3.0", ["1.3.1", "1.3.2"])).toBe("2 updates since 1.3.0: 1.3.1, 1.3.2");
  });
});

describe("shouldNotify", () => {
  const current = "0.11.0";
  const gate = (over: Partial<Parameters<typeof shouldNotify>[0]> = {}) =>
    shouldNotify({
      current,
      latest: "0.12.0",
      newerVersions: ["0.12.0"],
      lastNotified: null,
      lastPushedAt: null,
      now: AT_10AM,
      ...over,
    });

  it("fires for a strictly-newer, not-yet-announced release", () => {
    expect(gate()).toEqual({ send: true, versions: ["0.12.0"] });
    // Already announced this exact version -> no re-nag, even with the window wide open.
    expect(gate({ lastNotified: "0.12.0" })).toEqual({ send: false });
    // Not newer than what we're running -> never.
    expect(gate({ latest: "0.11.0", newerVersions: [] })).toEqual({ send: false });
    expect(gate({ latest: "0.10.0", newerVersions: [] })).toEqual({ send: false });
    expect(gate({ latest: null, newerVersions: [] })).toEqual({ send: false });
  });

  it("window closed suppresses the push — one a day, no matter how many releases land", () => {
    expect(gate({ lastPushedAt: hoursAgo(AT_10AM, 3), lastNotified: "0.11.5" })).toEqual({ send: false });
  });

  it("window open sends, and the digest names every folded version since the last one announced", () => {
    const verdict = gate({
      latest: "0.13.0",
      newerVersions: ["0.12.0", "0.12.1", "0.13.0"],
      lastNotified: "0.12.0",
      lastPushedAt: hoursAgo(AT_10AM, 30),
    });
    expect(verdict).toEqual({ send: true, versions: ["0.12.1", "0.13.0"] });
  });

  it("digest folds a whole release week into one push that names each version", () => {
    expect(
      gate({ latest: "0.14.0", newerVersions: ["0.12.0", "0.13.0", "0.14.0"] }),
    ).toEqual({ send: true, versions: ["0.12.0", "0.13.0", "0.14.0"] });
  });

  it("a patch-only delta waits out the week, then sends — it is a wait, not a mute", () => {
    const patches = { current: "1.3.0", latest: "1.3.2", newerVersions: ["1.3.1", "1.3.2"] };
    // Inside the 7-day patch window: the daily window would have opened days ago, this one has not.
    expect(gate({ ...patches, lastPushedAt: hoursAgo(AT_10AM, 30) })).toEqual({ send: false });
    expect(gate({ ...patches, lastPushedAt: hoursAgo(AT_10AM, 6 * 24) })).toEqual({ send: false });
    // Past it: an install that only ever sees patch releases is still nudged, once a week.
    expect(gate({ ...patches, lastPushedAt: hoursAgo(AT_10AM, 7 * 24 + 1) })).toEqual({
      send: true,
      versions: ["1.3.1", "1.3.2"],
    });
    // No push on record — a first-ever patch digest waits for nothing.
    expect(gate({ ...patches, lastPushedAt: null })).toEqual({ send: true, versions: ["1.3.1", "1.3.2"] });
    // The 09:00 rule still applies on top of the weekly window.
    expect(
      gate({ ...patches, lastPushedAt: hoursAgo(AT_10AM, 8 * 24), now: new Date(2026, 0, 15, 3, 0, 0) }),
    ).toEqual({ send: false });
  });

  it("a minor keeps the DAILY window, and carries the waiting patch releases with it", () => {
    const mixed = { current: "1.3.0", latest: "1.4.0", newerVersions: ["1.3.1", "1.3.2", "1.4.0"] };
    expect(gate(mixed)).toEqual({ send: true, versions: ["1.3.1", "1.3.2", "1.4.0"] });
    // 30 h after the last push: too soon for a patch train, in time for a minor.
    expect(gate({ ...mixed, lastPushedAt: hoursAgo(AT_10AM, 30) })).toEqual({
      send: true,
      versions: ["1.3.1", "1.3.2", "1.4.0"],
    });
  });

  it("before 09:00 it waits — a release published at night does not buzz a phone", () => {
    expect(gate({ now: new Date(2026, 0, 15, 3, 0, 0) })).toEqual({ send: false });
    expect(gate({ now: new Date(2026, 0, 15, 9, 0, 0) })).toEqual({ send: true, versions: ["0.12.0"] });
  });

  it("a legacy record with no push timestamp reads as no push yet, and sends", () => {
    expect(gate({ lastPushedAt: null })).toEqual({ send: true, versions: ["0.12.0"] });
    expect(gate({ lastPushedAt: "not-a-date" })).toEqual({ send: true, versions: ["0.12.0"] });
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
function fakeStore(
  initial: string | null = null,
  pushedAt: string | null = null,
): UpdateStore & { saved: string[]; pushes: string[]; closed: string[]; writes: number } {
  let last = initial;
  let stamp = pushedAt;
  let dismissed: string | null = null;
  let dismissedPack: string | null = null;
  const saved: string[] = [];
  const pushes: string[] = [];
  const closed: string[] = [];
  const counter = { writes: 0 };
  return {
    saved,
    pushes,
    closed,
    get writes() {
      return counter.writes;
    },
    lastNotified: () => last,
    lastPushedAt: () => stamp,
    setLastNotified: async (v, at) => {
      counter.writes += 1;
      last = v;
      stamp = at;
      saved.push(v);
      pushes.push(at);
    },
    dismissedVersion: () => dismissed,
    dismissedPackVersion: () => dismissedPack,
    setDismissed: async (scope, v, notified) => {
      counter.writes += 1;
      if (scope === "offer") dismissed = v;
      else dismissedPack = v;
      closed.push(`${scope}:${v}`);
      if (notified !== undefined) {
        last = notified.version;
        stamp = notified.pushedAt;
        saved.push(notified.version);
        pushes.push(notified.pushedAt);
      }
    },
  };
}

describe("the update run record on the snapshot", () => {
  it("the bridge resumes update state from disk instead of coming up with nothing to say", () => {
    // A bridge restarted BY an update must report the run it is part of. The record is read per
    // call, never cached, because the process that writes it is the detached updater (M15/04).
    const run = {
      schema: 1,
      state: "verifying",
      from: "v1.0.0",
      to: "v1.1.0",
      startedAt: 1,
      updatedAt: 2,
      pid: 7,
      attempt: 0,
    } as const;
    const { monitor } = makeMonitor({ runState: () => run });
    expect(monitor.status().run).toEqual(run);
  });

  it("names the package command only where the host resolved one", () => {
    // Assigned, never spread as `undefined`: an install with none must carry NO key. The phone's
    // fallback to the preflight remedy depends on the difference between absent and empty.
    expect("packageCommand" in makeMonitor().monitor.status()).toBe(false);
    const packaged = makeMonitor({ installKind: "packaged", packageCommand: "sudo pacman -Syu collie-bin" });
    expect(packaged.monitor.status().packageCommand).toBe("sudo pacman -Syu collie-bin");
  });

  it("an install that has never updated carries no run key at all", () => {
    const { monitor } = makeMonitor();
    expect("run" in monitor.status()).toBe(false);
  });
});

describe("restart needed — the files moved under a running process", () => {
  it("is quiet while disk still names the version this process runs", () => {
    const status = makeMonitor().monitor.status();
    expect(status.restartNeeded).toBe(false);
    // Nothing to restart, nothing to name: the command key is absent, not empty.
    expect("restartCommand" in status).toBe(false);
  });

  it("is raised the moment a live read disagrees with the version captured at boot", () => {
    // Exactly what `pacman -Syu` does: the files become 1.6.0 while this process is still 1.5.0.
    let onDisk = "1.5.0";
    const { monitor, tick } = makeMonitor({
      current: "1.5.0",
      bootVersion: "1.5.0",
      liveVersion: () => onDisk,
    });
    expect(monitor.status().restartNeeded).toBe(false);
    onDisk = "1.6.0";
    tick(10_000); // past the throttle the read shares with `bridgeStale`
    expect(monitor.status().restartNeeded).toBe(true);

    // Not latched: a package manager that puts the old files back leaves a process that matches disk
    // again, and asking for a restart nobody needs is worse than saying nothing.
    onDisk = "1.5.0";
    tick(10_000);
    expect(monitor.status().restartNeeded).toBe(false);
  });

  it("restart command for the install kind, never a hard-coded string", () => {
    // Two spellings, and the kind is the whole of what picks one (M14/01 §5.3).
    expect(restartCommandFor("detached-checkout")).toBe("herdr plugin action invoke restart --plugin herdr.collie");
    // A PACKAGED install takes the `collie` verb like any other non-Herdr kind. Our package ships no
    // unit file at all — `collie start` writes the operator's own `--user` unit — so the system-unit
    // spelling would name a unit that does not exist and ask for a password to restart it.
    for (const kind of ["packaged", "linked-clone", "binary", "unknown"] as const) {
      expect(restartCommandFor(kind)).toBe("collie restart");
    }
    expect(restartCommandFor("packaged")).not.toContain("sudo");

    // And the snapshot names the one this machine takes, off the same function.
    const swapped = { bootVersion: "1.5.0", liveVersion: () => "1.6.0" };
    for (const kind of ["packaged", "detached-checkout", "binary"] as const) {
      const status = makeMonitor({ installKind: kind, ...swapped }).monitor.status();
      expect(status.restartCommand).toBe(restartCommandFor(kind));
    }
  });
});

/** Tag names as the `/tags` endpoint reports them — one parser, so the monitor's fixtures name what
 *  the CLI's binary updater reads too. The sha is arbitrary here: the banner never looks at it. */
const apiTags = (...names: string[]): ApiTag[] => names.map((name) => ({ name, sha: `sha-${name}` }));

function makeMonitor(over: Partial<UpdateMonitorDeps> = {}) {
  const notified: string[] = [];
  const store = fakeStore();
  // 10:00 on a fixed LOCAL day: past the digest's earliest hour, so these tests exercise the monitor
  // rather than the clock. `tick` moves it forward within the same morning unless a test says otherwise.
  let clock = new Date(2026, 0, 15, 10, 0, 0).getTime();
  const monitor = new UpdateMonitor({
    repo: "AltanS/collie",
    current: "0.11.0",
    installKind: "detached-checkout",
    packageCommand: null,
    bootVersion: "0.11.0",
    liveVersion: () => "0.11.0",
    startupStamp: "STAMP@boot",
    fetchTags: async () => apiTags("v0.12.0"),
    bridgeStamp: () => "STAMP@boot",
    store,
    // No run on disk unless a case says so — the shape every install that has never updated has.
    runState: () => null,
    now: () => clock,
    updatesEnabled: () => true,
    notify: (versions) => notified.push(...versions),
    ...over,
  });
  return { monitor, notified, store, tick: (ms: number) => (clock += ms) };
}

describe("UpdateMonitor", () => {
  it("surfaces releaseAvailable + latest + latestUrl after a successful check", async () => {
    // Use a REAL Collie release (v0.10.3) with `current` below it, so the asserted release URL exists.
    const { monitor } = makeMonitor({
      current: "0.9.0",
      fetchTags: async () => apiTags("v0.2.0", "v0.10.0", "v0.10.3"),
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

  it("reports the install kind it was constructed with — the banner spells its commands from it", () => {
    const { monitor } = makeMonitor({ installKind: "binary" });
    expect(monitor.status().installKind).toBe("binary");
  });

  it("splits the answer: the newest release of MY major, and a higher major named apart from it", async () => {
    // The banner has to say WHICH kind of behind you are (ADR 0020) — a routine update fixes one and
    // refuses the other, so one field could not carry both.
    const { monitor } = makeMonitor({
      current: "0.31.1",
      fetchTags: async () => apiTags("v0.31.1", "v0.32.0", "v1.0.0", "v1.0.1"),
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
      fetchTags: async () => apiTags("v0.32.0", "v1.0.0"),
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "1.0.0", // the beta is behind its own release
      releaseAvailable: true,
      majorAvailable: null,
      majorUrl: null,
    });
  });

  it("a beta install is offered the next beta — the banner follows the train too", async () => {
    // The banner and the verb share `latestUpdateInMajor`, so this is the same rule, not a copy of it.
    const { monitor, notified } = makeMonitor({
      current: "1.0.0-beta.44",
      fetchTags: async () => apiTags("v0.32.0", "v1.0.0-beta.44", "v1.0.0-beta.45", "nightly"),
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({
      latest: "1.0.0-beta.45",
      latestUrl: "https://github.com/AltanS/collie/releases/tag/v1.0.0-beta.45",
      releaseAvailable: true,
      majorAvailable: null,
    });
    expect(notified).toEqual(["1.0.0-beta.45"]);
  });

  it("a beta install already on the newest beta is offered nothing", async () => {
    const { monitor, notified } = makeMonitor({
      current: "1.0.0-beta.45",
      fetchTags: async () => apiTags("v1.0.0-beta.44", "v1.0.0-beta.45"),
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({ latest: "1.0.0-beta.45", releaseAvailable: false });
    expect(notified).toEqual([]);
  });

  it("a beta install is pointed at the RELEASE once it exists, skipping the betas after it", async () => {
    const { monitor } = makeMonitor({
      current: "1.0.0-beta.44",
      fetchTags: async () => apiTags("v1.0.0-beta.45", "v1.0.0", "v1.1.0-rc.1"),
    });
    await monitor.checkRelease();
    // v1.0.0, not beta.45 (superseded) and not v1.1.0-rc.1 (the consent ended at the release).
    expect(monitor.status()).toMatchObject({ latest: "1.0.0", releaseAvailable: true });
  });

  it("a STABLE install stays blind to prereleases — no banner for a beta, ever", async () => {
    const { monitor, notified } = makeMonitor({
      current: "1.0.0",
      fetchTags: async () => apiTags("v1.0.0", "v1.1.0-beta.1", "v1.1.0-rc.2"),
    });
    await monitor.checkRelease();
    expect(monitor.status()).toMatchObject({ latest: "1.0.0", releaseAvailable: false });
    expect(notified).toEqual([]);
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
      lastPushedAt: store.lastPushedAt,
      dismissedVersion: store.dismissedVersion,
      dismissedPackVersion: store.dismissedPackVersion,
      setDismissed: store.setDismissed,
      setLastNotified: async (v, at) => {
        order.push(`persist:${v}`);
        await store.setLastNotified(v, at);
      },
    };
    const { monitor, notified } = makeMonitor({
      store: wrapped,
      notify: (versions) => order.push(`notify:${versions.join(",")}`),
    });
    await monitor.checkRelease();
    await monitor.checkRelease(); // same latest → no re-nag
    expect(order).toEqual(["persist:0.12.0", "notify:0.12.0"]); // persisted first, fired once
    expect(notified).toEqual([]); // notify routed into `order` above
  });

  it("the off switch suppresses everything — the updates pref off means no push, at any hour", async () => {
    const { monitor, notified, store } = makeMonitor({ updatesEnabled: () => false });
    await monitor.checkRelease();
    expect(notified).toEqual([]);
    expect(store.saved).toEqual([]); // nothing announced either, so turning it back on still tells you
    expect(monitor.status().releaseAvailable).toBe(true); // the banner still shows; only the push is gated
  });

  it("the snapshot reports releaseAvailable independent of the digest window", async () => {
    // Pushed an hour ago -> the window is shut, but the card must still name the new release.
    const store = fakeStore("0.11.5", new Date(2026, 0, 15, 9, 0, 0).toISOString());
    const { monitor, notified } = makeMonitor({ store });
    await monitor.checkRelease();
    expect(notified).toEqual([]); // window closed
    expect(monitor.status()).toMatchObject({ latest: "0.12.0", releaseAvailable: true });
  });

  it("folds a closed window into one digest that names every version it held back", async () => {
    const store = fakeStore("0.11.0", new Date(2026, 0, 15, 9, 0, 0).toISOString());
    const { monitor, notified, tick } = makeMonitor({
      store,
      fetchTags: async () => apiTags("v0.12.0", "v0.12.1", "v0.13.0"),
    });
    await monitor.checkRelease();
    expect(notified).toEqual([]); // still inside the window
    tick(25 * 3600_000); // next morning, window open
    await monitor.checkRelease();
    expect(notified).toEqual(["0.12.0", "0.12.1", "0.13.0"]);
    expect(store.saved).toEqual(["0.13.0"]); // the newest is what "already announced" now means
    await monitor.checkRelease();
    expect(notified).toEqual(["0.12.0", "0.12.1", "0.13.0"]); // ignoring a digest never re-fires it
  });

  it("a patch-only train rides the weekly digest, and the card is current the whole time", async () => {
    const store = fakeStore("1.3.0", new Date(2026, 0, 14, 10, 0, 0).toISOString()); // pushed a day ago
    const { monitor, notified, tick } = makeMonitor({
      current: "1.3.0",
      store,
      fetchTags: async () => apiTags("v1.3.1", "v1.3.2"),
    });
    await monitor.checkRelease();
    expect(notified).toEqual([]); // the daily window is open; the patch window is not
    expect(monitor.status().releaseAvailable).toBe(true); // the card is current regardless
    tick(7 * 24 * 3600_000); // a week on
    await monitor.checkRelease();
    expect(notified).toEqual(["1.3.1", "1.3.2"]);
  });

  it("snoozeDigest marks the current latest announced and closes the window", async () => {
    const { monitor, notified, store } = makeMonitor();
    await monitor.checkRelease();
    expect(notified).toEqual(["0.12.0"]);
    await monitor.snoozeDigest();
    expect(store.saved).toEqual(["0.12.0", "0.12.0"]);
    expect(store.pushes).toHaveLength(2);
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
    const { monitor, notified } = makeMonitor({ fetchTags: async () => apiTags("v0.11.0", "v0.10.0") });
    await monitor.checkRelease();
    expect(monitor.status().releaseAvailable).toBe(false);
    expect(notified).toEqual([]);
  });

  it("de-dupes concurrent checks — one fetch backs both callers, then the guard clears", async () => {
    let calls = 0;
    let release!: (tags: ApiTag[]) => void;
    const gate = new Promise<ApiTag[]>((r) => {
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
    release(apiTags("v0.12.0"));
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

describe("parseTagsResponse", () => {
  it("keeps a tag's name and the commit it points at, and drops anything it cannot read", () => {
    expect(
      parseTagsResponse([
        { name: "v1.0.0", commit: { sha: "abc" } },
        { name: "v1.1.0", commit: { sha: "def" }, zipball_url: "ignored" },
        { name: 7, commit: { sha: "x" } },
        { name: "v1.2.0" },
        { name: "v1.3.0", commit: { sha: "" } },
        "not an object",
      ]),
    ).toEqual([
      { name: "v1.0.0", sha: "abc" },
      { name: "v1.1.0", sha: "def" },
    ]);
    expect(parseTagsResponse({ message: "rate limited" })).toEqual([]);
  });

  // An EMPTY sha is worse than a dropped tag: `planUpdate` compares a candidate's commit against the
  // installed head, and a binary install's head is `""` — so an empty sha would report a real update
  // as "already current".
  it("never emits an empty sha", () => {
    expect(parseTagsResponse([{ name: "v1.0.0", commit: { sha: "" } }])).toEqual([]);
  });
});

describe("parseReleaseManifest", () => {
  const doc = {
    schemaVersion: 1,
    repo: "AltanS/collie",
    tag: "v1.1.0",
    version: "1.1.0",
    artifacts: [
      {
        name: "collie-1.1.0-linux-x64.tar.gz",
        platform: "linux-x64",
        os: "linux",
        sha256: "deadbeef",
        size: 42,
        payloadRoot: "collie-1.1.0-linux-x64",
      },
    ],
    extras: [{ name: "web-dist-1.1.0.tar.gz", role: "web-bundle", sha256: "cafe" }],
  };

  it("reads the fields it needs and ignores the ones it does not — additive is free", () => {
    const v = parseReleaseManifest(doc);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.version).toBe("1.1.0");
    expect(v.manifest.artifacts).toEqual([
      {
        name: "collie-1.1.0-linux-x64.tar.gz",
        platform: "linux-x64",
        sha256: "deadbeef",
        size: 42,
        payloadRoot: "collie-1.1.0-linux-x64",
      },
    ]);
  });

  it("a schemaVersion it does not know is reported, never attempted", () => {
    expect(parseReleaseManifest({ ...doc, schemaVersion: 2 })).toEqual({
      ok: false,
      reason: "schema",
      schemaVersion: 2,
    });
  });

  it("a document of the wrong shape is unreadable, not half-believed", () => {
    expect(parseReleaseManifest({ schemaVersion: 1, version: "1.1.0" })).toEqual({ ok: false, reason: "unreadable" });
    expect(parseReleaseManifest("nope")).toEqual({ ok: false, reason: "unreadable" });
    expect(parseReleaseManifest(null)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("drops an artifact entry that cannot name itself, keeping the rest", () => {
    const v = parseReleaseManifest({ ...doc, artifacts: [{ name: "x" }, ...doc.artifacts] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.manifest.artifacts).toHaveLength(1);
  });
});

// ── The band's dismissal (M17/08) ─────────────────────────────────────────────
//
// A dismissal is a decision about THIS MACHINE's update, so it is kept here rather than in one
// browser's storage — and it is one act, not two: the version is recorded and the digest is snoozed
// in the same call, because closing the band and then being pushed the same version tomorrow is the
// app arguing with a decision already made.

const dismissDirs: string[] = [];
async function tempCfg() {
  const stateDir = await mkdtemp(join(tmpdir(), "collie-update-dismiss-"));
  dismissDirs.push(stateDir);
  return { ...loadConfig(), stateDir };
}

afterAll(async () => {
  await Promise.all(dismissDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("the dismissed version", () => {
  it("round-trips both scopes through the store, in one file beside the push record", async () => {
    const cfg = await tempCfg();
    const store = new UpdateStateStore(cfg);
    await store.load();
    expect(store.dismissedVersion()).toBeNull(); // nothing saved yet reads as nothing dismissed
    expect(store.dismissedPackVersion()).toBeNull();

    await store.setDismissed("offer", "1.6.0", { version: "1.6.0", pushedAt: "2026-09-07T09:00:00.000Z" });
    await store.setDismissed("pack", "1.5.0");

    const reloaded = new UpdateStateStore(cfg);
    await reloaded.load();
    expect(reloaded.dismissedVersion()).toBe("1.6.0");
    // Two decisions, two fields: the pack notice was put down at a DIFFERENT version and neither
    // overwrote the other.
    expect(reloaded.dismissedPackVersion()).toBe("1.5.0");
    // The offer's dismissal folded the snooze into the same write — a crash between two writes
    // cannot leave a band closed with the push still armed for it.
    expect(reloaded.lastNotified()).toBe("1.6.0");
    expect(reloaded.lastPushedAt()).toBe("2026-09-07T09:00:00.000Z");
  });

  it("reads a record that carries neither key as nothing dismissed", async () => {
    const cfg = await tempCfg();
    await Bun.write(
      join(cfg.stateDir, "update-state.json"),
      JSON.stringify({ lastNotified: "1.5.0", lastPushedAt: "2026-09-06T09:00:00.000Z" }),
    );
    const store = new UpdateStateStore(cfg);
    await store.load();
    expect(store.dismissedVersion()).toBeNull();
    expect(store.dismissedPackVersion()).toBeNull();
    expect(store.lastNotified()).toBe("1.5.0"); // and the record beside them is still believed
  });

  it("a dismissed offer for the release upstream names also snoozes the digest, in one write", async () => {
    const { monitor, store } = makeMonitor();
    await monitor.checkRelease();
    expect(store.saved).toEqual(["0.12.0"]); // the first push announced it
    const before = store.writes;

    await monitor.dismiss("0.12.0");
    expect(store.closed).toEqual(["offer:0.12.0"]);
    expect(store.lastNotified()).toBe("0.12.0");
    expect(store.writes - before).toBe(1); // one act, one write
    expect(monitor.status().dismissedVersion).toBe("0.12.0");
  });

  it("a dismiss with scope pack hides a notice and leaves lastNotified alone", async () => {
    const { monitor, store } = makeMonitor();
    await monitor.checkRelease();
    const notified = store.lastNotified();

    await monitor.dismiss("0.12.0", "pack");
    expect(store.closed).toEqual(["pack:0.12.0"]);
    // The push is about THIS machine; the notice was about another one. Hiding it silences nothing.
    expect(store.lastNotified()).toBe(notified);
    expect(monitor.status().dismissedPackVersion).toBe("0.12.0");
    expect(monitor.status().dismissedVersion).toBeNull(); // and the offer is untouched
  });

  it("a dismissed offer for a version that is not latest leaves lastNotified alone", async () => {
    const { monitor, store } = makeMonitor();
    await monitor.checkRelease();
    const notified = store.lastNotified();

    // Closing a band about 0.11.9 says nothing about the 0.12.0 the digest would push, and moving
    // the record there would swallow the version upstream is actually naming.
    await monitor.dismiss("0.11.9");
    expect(monitor.status().dismissedVersion).toBe("0.11.9");
    expect(store.lastNotified()).toBe(notified);
  });

  it("a dismiss is not a mute — a newer release is a different version and raises the band", async () => {
    const { monitor } = makeMonitor();
    await monitor.checkRelease();
    await monitor.dismiss("0.12.0");
    expect(monitor.status()).toMatchObject({ latest: "0.12.0", dismissedVersion: "0.12.0" });
    // The snapshot keeps saying a release is available; only the BAND reads the two together, and it
    // reads them as different facts the moment upstream moves on.
    expect(monitor.status().releaseAvailable).toBe(true);
  });
});
